// Standalone Socket.IO Server for Telegram Clone

import { Server } from 'socket.io';
import { createServer } from 'http';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// MongoDB Schemas
const { Schema, model } = mongoose;

const UserSchema = new Schema({
  name: String,
  lastName: String, // 🔥 إضافة lastName
  username: String,
  avatar: String, // 🔥 هذا الحقل يجب أن يكون موجوداً
  biography: String, // 🔥 إضافة السيرة الذاتية
  phone: String, // 🔥 إضافة رقم الهاتف
  password: String,
  rooms: [{ type: Schema.Types.ObjectId, ref: 'Room' }],
  roomMessageTrack: [{ roomId: String, scrollPos: Number }],
}, { timestamps: true });

const MessageSchema = new Schema({
  sender: { type: Schema.Types.ObjectId, ref: 'User' },
  message: String,
  roomID: { type: Schema.Types.ObjectId, ref: 'Room' },
  seen: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  voiceData: {
    src: String,
    duration: Number,
    playedBy: [String],
  },
  fileData: Schema.Types.Mixed, 
  createdAt: { type: Date, default: Date.now },
  tempId: String,
  status: String,
  isEdited: Boolean,
  hideFor: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  replays: [{ type: Schema.Types.ObjectId, ref: 'Message' }],
  replayedTo: Schema.Types.Mixed,
  pinnedAt: Date,
  readTime: Date,
});

const RoomSchema = new Schema({
  name: String,
  type: String,
  avatar: String,
  description: String,
  creator: { type: Schema.Types.ObjectId, ref: 'User' },
  participants: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  admins: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  messages: [{ type: Schema.Types.ObjectId, ref: 'Message' }],
  medias: [Schema.Types.Mixed],
  locations: [Schema.Types.Mixed],
}, { timestamps: true });

// Create models (only if not already created)
const User = mongoose.models.User || model('User', UserSchema);
const Message = mongoose.models.Message || model('Message', MessageSchema);
const Room = mongoose.models.Room || model('Room', RoomSchema);

// Connect to MongoDB
const connectDB = async () => {
  try {
    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined');
    }

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGODB_URI);
      console.log('✅ Connected to MongoDB successfully');
    }
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Initialize HTTP Server
const PORT = process.env.PORT || 3001;
const httpServer = createServer();

// Initialize Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

let typings = [];
let onlineUsers = [];

// Connect to DB before starting server
await connectDB();

io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);

  // ==========================================
  // 🔥 إضافة معالج تحديث بيانات المستخدم (الصورة الشخصية)
  // ==========================================
  socket.on('updateUserData', async (data) => {
    try {
      const { userID, avatar, name, lastName, biography, username } = data;
      
      console.log('📝 Updating user data:', { userID, avatar, name, lastName, biography, username });

      if (!userID) {
        socket.emit('updateUserData', { 
          success: false, 
          error: 'User ID is required' 
        });
        return;
      }

      // إنشاء كائن التحديثات فقط للحقول المرسلة
      const updateFields = {};
      if (avatar !== undefined) updateFields.avatar = avatar;
      if (name !== undefined) updateFields.name = name;
      if (lastName !== undefined) updateFields.lastName = lastName;
      if (biography !== undefined) updateFields.biography = biography;
      if (username !== undefined) updateFields.username = username;

      // تحديث بيانات المستخدم في قاعدة البيانات
      const updatedUser = await User.findByIdAndUpdate(
        userID,
        { $set: updateFields },
        { new: true, runValidators: true }
      ).select('name lastName username avatar biography phone _id');

      if (!updatedUser) {
        socket.emit('updateUserData', { 
          success: false, 
          error: 'User not found' 
        });
        return;
      }

      console.log('✅ User updated successfully:', updatedUser);

      // إرسال تأكيد النجاح للعميل الذي أرسل الطلب
      socket.emit('updateUserData', { 
        success: true,
        user: updatedUser
      });

      // 🔥 إرسال التحديث لجميع الاتصالات النشطة للمستخدم
      const userSockets = onlineUsers.filter(u => u.userID === userID.toString());
      userSockets.forEach(({ socketID }) => {
        io.to(socketID).emit('userDataUpdated', {
          avatar: updatedUser.avatar,
          name: updatedUser.name,
          lastName: updatedUser.lastName,
          biography: updatedUser.biography,
          username: updatedUser.username,
        });
      });

      // 🔥 تحديث الرسائل والغرف التي تحتوي على هذا المستخدم
      // (لتحديث الصورة في المحادثات)
      if (avatar !== undefined) {
        // تحديث صورة المستخدم في جميع الغرف الخاصة
        const userRooms = await Room.find({
          participants: userID,
          type: 'private'
        }).select('_id participants');

        userRooms.forEach(room => {
          io.to(room._id.toString()).emit('participantAvatarUpdate', {
            userID,
            avatar: updatedUser.avatar,
            name: updatedUser.name,
            lastName: updatedUser.lastName,
          });
        });
      }

    } catch (updateError) {
      console.error('❌ Error updating user data:', updateError);
      socket.emit('updateUserData', { 
        success: false, 
        error: updateError.message || 'Failed to update user data' 
      });
    }
  });

  // ==========================================
  // 🔥 إضافة معالج لجلب بيانات المستخدم
  // ==========================================
  socket.on('getUserData', async (userID) => {
    try {
      console.log('📥 Fetching user data for:', userID);

      const user = await User.findById(userID)
        .select('name lastName username avatar biography phone _id');

      if (!user) {
        socket.emit('getUserData', { 
          success: false, 
          error: 'User not found' 
        });
        return;
      }

      socket.emit('getUserData', { 
        success: true,
        user: user
      });

    } catch (fetchError) {
      console.error('❌ Error fetching user data:', fetchError);
      socket.emit('getUserData', { 
        success: false, 
        error: 'Failed to fetch user data' 
      });
    }
  });

  socket.on('newMessage', async (data, callback) => {
    try {
      const { roomID, sender, message, replayData, voiceData = null, tempId, fileData = null } = data;
      
      const msgData = {
        sender,
        message,
        roomID,
        seen: [],
        voiceData,
        fileData, 
        createdAt: Date.now(),
        tempId,
        status: 'sent',
      };

      let newMsg = await Message.findOne({ tempId }).lean();

      if (newMsg) {
        socket.to(roomID).emit('newMessage', {
          ...newMsg,
          replayedTo: replayData ? replayData.replayedTo : null,
        });

        socket.emit('newMessageIdUpdate', { tempId, _id: newMsg._id });
        io.to(roomID).emit('lastMsgUpdate', newMsg);
        io.to(roomID).emit('updateLastMsgData', { msgData: newMsg, roomID });
        
        if (callback) callback({ success: true, _id: newMsg._id });
      } else {
        newMsg = await Message.create(msgData);
        const populatedMsg = await Message.findById(newMsg._id)
          .populate('sender', 'name lastName username avatar _id')
          .lean();

        socket.to(roomID).emit('newMessage', {
          ...populatedMsg,
          replayedTo: replayData ? replayData.replayedTo : null,
        });

        socket.emit('newMessageIdUpdate', { tempId, _id: populatedMsg._id });
        io.to(roomID).emit('lastMsgUpdate', populatedMsg);
        io.to(roomID).emit('updateLastMsgData', { msgData: populatedMsg, roomID });

        if (replayData) {
          await Message.findOneAndUpdate(
            { _id: replayData.targetID },
            { $push: { replays: newMsg._id } }
          );
        }

        await Room.findOneAndUpdate(
          { _id: roomID },
          { $push: { messages: newMsg._id } }
        );

        if (callback) callback({ success: true, _id: newMsg._id });
      }
    } catch (messageError) {
      console.error('❌ Error in newMessage:', messageError);
      if (callback) callback({ success: false, error: 'Failed to send message' });
    }
  });

  socket.on('getRooms', async (userID) => {
    try {
      const userRooms = await Room.find({
        participants: { $in: userID },
      }).lean();

      const userPvs = await Room.find({
        $and: [{ participants: { $in: userID } }, { type: 'private' }],
      })
        .lean()
        .populate('participants');

      for (const room of userRooms) {
        room.participants =
          userPvs.find((data) => data._id.toString() === room._id.toString())?.participants ||
          room.participants;
        socket.join(room._id.toString());
      }

      const existingUser = onlineUsers.find((user) => user.socketID === socket.id);
      if (!existingUser) {
        onlineUsers.push({ socketID: socket.id, userID });
      }

      io.to([...socket.rooms]).emit('updateOnlineUsers', onlineUsers);

      const getRoomsData = async () => {
        const promises = userRooms.map(async (room) => {
          const lastMsgData = room?.messages?.length
            ? await Message.findOne({ _id: room.messages.at(-1)?._id })
                .populate('sender', 'name lastName username avatar _id') // 🔥 تحميل بيانات المرسل
            : null;

          const notSeenCount = await Message.find({
            $and: [
              { roomID: room?._id },
              { sender: { $ne: userID } },
              { seen: { $nin: [userID] } },
            ],
          });

          return {
            ...room,
            lastMsgData,
            notSeenCount: notSeenCount?.length,
          };
        });

        return Promise.all(promises);
      };

      const rooms = await getRoomsData();
      socket.emit('getRooms', rooms);
    } catch (roomsError) {
      console.error('❌ Error in getRooms:', roomsError);
    }
  });

  socket.on('joining', async (query, defaultRoomData = null) => {
    try {
      let roomData = await Room.findOne({
        $or: [{ _id: query }, { name: query }],
      })
        .populate('messages')
        .populate({
          path: 'messages',
          populate: { 
            path: 'sender', 
            model: User,
            select: 'name lastName username avatar _id' // 🔥 تحديد الحقول المطلوبة
          },
        });

      if (roomData && roomData?.type === 'private') {
        await roomData.populate('participants');
      }

      if (!roomData?._id) {
        roomData = defaultRoomData;
      }

      socket.emit('joining', roomData);
    } catch (joiningError) {
      console.error('❌ Error in joining:', joiningError);
    }
  });

  socket.on('createRoom', async ({ newRoomData, message = null }) => {
    try {
      let isRoomExist = false;

      if (newRoomData.type === 'private') {
        isRoomExist = await Room.findOne({ name: newRoomData.name });
      } else {
        isRoomExist = await Room.findOne({ _id: newRoomData._id });
      }

      if (!isRoomExist) {
        let msgData = message;

        if (newRoomData.type === 'private') {
          newRoomData.participants = newRoomData.participants.map((data) => data?._id);
        }

        const newRoom = await Room.create(newRoomData);

        if (msgData) {
          const newMsg = await Message.create({
            ...msgData,
            roomID: newRoom._id,
          });
          msgData = newMsg;
          newRoom.messages = [newMsg._id];
          await newRoom.save();
        }

        socket.join(newRoom._id.toString());

        const otherRoomMembersSocket = onlineUsers.filter((data) =>
          newRoom.participants.some((pID) => data.userID === pID.toString())
        );

        otherRoomMembersSocket.forEach(({ socketID: userSocketID }) => {
          const socketID = io.sockets.sockets.get(userSocketID);
          if (socketID) socketID.join(newRoom._id.toString());
        });

        io.to(newRoom._id.toString()).emit('createRoom', newRoom);
      }
    } catch (createRoomError) {
      console.error('❌ Error in createRoom:', createRoomError);
    }
  });

  socket.on('typing', (data) => {
    if (!typings.includes(data.sender.name)) {
      io.to(data.roomID).emit('typing', data);
      typings.push(data.sender.name);
    }
  });

  socket.on('stop-typing', (data) => {
    typings = typings.filter((tl) => tl !== data.sender.name);
    io.to(data.roomID).emit('stop-typing', data);
  });

  socket.on('seenMsg', async (seenData) => {
    try {
      io.to(seenData.roomID).emit('seenMsg', seenData);
      await Message.findOneAndUpdate(
        { _id: seenData.msgID },
        {
          $push: { seen: seenData.seenBy },
          $set: { readTime: new Date(seenData.readTime) },
        }
      );
    } catch (seenError) {
      console.error('❌ Error in seenMsg:', seenError);
    }
  });

  socket.on('deleteMsg', async ({ forAll, msgID, roomID }) => {
    try {
      if (forAll) {
        io.to(roomID).emit('deleteMsg', msgID);
        const userID = onlineUsers.find((ud) => ud.socketID == socket.id)?.userID;

        await Message.findOneAndDelete({ _id: msgID });

        const lastMsg = await Message.findOne({
          roomID: roomID,
          hideFor: { $nin: [userID] },
        })
        .sort({ createdAt: -1 })
        .populate('sender', 'name lastName username avatar _id'); // 🔥 تحميل بيانات المرسل

        if (lastMsg) {
          io.to(roomID).emit('updateLastMsgData', { msgData: lastMsg, roomID });
        }

        await Room.findOneAndUpdate({ _id: roomID }, { $pull: { messages: msgID } });
      }
    } catch (deleteError) {
      console.error('❌ Error in deleteMsg:', deleteError);
    }
  });

  socket.on('editMessage', async ({ msgID, editedMsg, roomID }) => {
    try {
      io.to(roomID).emit('editMessage', { msgID, editedMsg, roomID });
      const updatedMsgData = await Message.findOneAndUpdate(
        { _id: msgID },
        { message: editedMsg, isEdited: true }
      )
      .lean()
      .populate('sender', 'name lastName username avatar _id'); // 🔥 تحميل بيانات المرسل

      if (!updatedMsgData) return;

      const lastMsg = await Message.findOne({ roomID })
        .sort({ createdAt: -1 })
        .lean()
        .populate('sender', 'name lastName username avatar _id'); // 🔥 تحميل بيانات المرسل

      if (lastMsg && lastMsg._id.toString() === msgID) {
        io.to(roomID).emit('updateLastMsgData', {
          roomID,
          msgData: { ...updatedMsgData, message: editedMsg },
        });
      }
    } catch (editError) {
      console.error('❌ Error in editMessage:', editError);
    }
  });

  socket.on('updateRoomData', async (updatedFields) => {
    try {
      const { roomID, ...fieldsToUpdate } = updatedFields;

      const updatedRoom = await Room.findOneAndUpdate(
        { _id: roomID },
        { $set: fieldsToUpdate },
        { new: true }
      );

      if (!updatedRoom) {
        throw new Error('Room not found');
      }

      io.to(updatedFields.roomID).emit('updateRoomData', updatedRoom);
    } catch (updateRoomError) {
      console.error('❌ Error updating room:', updateRoomError);
      socket.emit('updateRoomDataError', { message: updateRoomError.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ Client disconnected:', socket.id);
    onlineUsers = onlineUsers.filter((data) => data.socketID !== socket.id);
    io.to([...socket.rooms]).emit('updateOnlineUsers', onlineUsers);
  });
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Socket.IO server is running on port ${PORT}`);
  console.log(`📡 CORS enabled for all origins`);
});

// Handle errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
