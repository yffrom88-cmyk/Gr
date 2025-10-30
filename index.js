// Standalone Socket.IO Server for Telegram Clone (FINAL & COMPLETE VERSION)

import { Server } from 'socket.io';
import { createServer } from 'http';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// ===========================================
// 1. MongoDB Schemas & Models
// ===========================================
const { Schema, model } = mongoose;

const UserSchema = new Schema({
  name: String,
  lastName: String, 
  username: String,
  avatar: String, 
  biography: String, 
  phone: String, 
  password: String,
  rooms: [{ type: Schema.Types.ObjectId, ref: 'Room' }],
  roomMessageTrack: [{ roomId: String, scrollPos: Number }], // 🔥 مدمج الآن
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
  pinnedAt: Date, // 🔥 مدمج الآن
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
  lastMessage: { type: Schema.Types.ObjectId, ref: 'Message' }, 
  medias: [Schema.Types.Mixed],
  locations: [Schema.Types.Mixed],
}, { timestamps: true });

// Create models (only if not already created)
const User = mongoose.models.User || model('User', UserSchema);
const Message = mongoose.models.Message || model('Message', MessageSchema);
const Room = mongoose.models.Room || model('Room', RoomSchema);

// ===========================================
// 2. DB Connection & Server Setup
// ===========================================

const connectDB = async () => {
  try {
    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) throw new Error('MONGODB_URI is not defined');

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGODB_URI);
      console.log('✅ Connected to MongoDB successfully');
    }
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const PORT = process.env.PORT || 3001;
const httpServer = createServer();

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

// ===========================================
// 3. Socket.IO Handlers (المعالجات)
// ===========================================

io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);

  // -------------------------------------------------------------
  // 🔥 إدارة المستخدمين والملفات الشخصية (USER MANAGEMENT)
  // -------------------------------------------------------------

  socket.on('updateUserData', async (data) => {
    try {
      const { userID, avatar, name, lastName, biography, username } = data;
      const updateFields = {};
      if (avatar !== undefined) updateFields.avatar = avatar;
      if (name !== undefined) updateFields.name = name;
      if (lastName !== undefined) updateFields.lastName = lastName;
      if (biography !== undefined) updateFields.biography = biography;
      if (username !== undefined) updateFields.username = username;

      const updatedUser = await User.findByIdAndUpdate(
        userID,
        { $set: updateFields },
        { new: true, runValidators: true }
      ).select('name lastName username avatar biography phone _id');

      if (!updatedUser) {
        socket.emit('updateUserData', { success: false, error: 'User not found' });
        return;
      }

      socket.emit('updateUserData', { success: true, user: updatedUser });

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
      
      if (avatar !== undefined) {
        const userRooms = await Room.find({ participants: userID, type: 'private' }).select('_id');
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
      socket.emit('updateUserData', { success: false, error: 'Failed to update user data' });
    }
  });

  socket.on('getUserData', async (userID) => {
    try {
      const user = await User.findById(userID).select('name lastName username avatar biography phone _id');
      if (!user) {
        socket.emit('getUserData', { success: false, error: 'User not found' });
        return;
      }
      socket.emit('getUserData', { success: true, user: user });
    } catch (fetchError) {
      console.error('❌ Error fetching user data:', fetchError);
      socket.emit('getUserData', { success: false, error: 'Failed to fetch user data' });
    }
  });


  // -------------------------------------------------------------
  // 🔥 الرسائل (MESSAGES)
  // -------------------------------------------------------------

  socket.on('newMessage', async (data, callback) => {
    try {
      const { roomID, sender, message, replayData, voiceData = null, tempId, fileData = null } = data;
      
      const msgData = {
        sender,
        message,
        roomID,
        seen: [sender], 
        voiceData,
        fileData, 
        createdAt: Date.now(),
        tempId,
        status: 'sent',
      };

      let newMsg = await Message.findOne({ tempId }).lean();

      if (!newMsg) {
        newMsg = await Message.create(msgData);
        
        await Room.findOneAndUpdate(
          { _id: roomID },
          { 
            $push: { messages: newMsg._id },
            $set: { lastMessage: newMsg._id } 
          }
        );

        if (replayData) {
          await Message.findOneAndUpdate(
            { _id: replayData.targetID },
            { $push: { replays: newMsg._id } }
          );
        }
      }

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

      if (callback) callback({ success: true, _id: populatedMsg._id });

    } catch (messageError) {
      console.error('❌ Error in newMessage:', messageError);
      if (callback) callback({ success: false, error: 'Failed to send message' });
    }
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
        await Room.findOneAndUpdate({ _id: roomID }, { $pull: { messages: msgID } });

        const lastMsg = await Message.findOne({ roomID: roomID, hideFor: { $nin: [userID] } })
          .sort({ createdAt: -1 })
          .populate('sender', 'name lastName username avatar _id'); 

        io.to(roomID).emit('updateLastMsgData', { msgData: lastMsg, roomID });
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
        { message: editedMsg, isEdited: true },
        { new: true }
      ).lean()
      .populate('sender', 'name lastName username avatar _id'); 

      if (!updatedMsgData) return;

      const lastMsg = await Message.findOne({ roomID }).sort({ createdAt: -1 }).lean();
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

  // 🔥 إضافة معالج تثبيت/إلغاء تثبيت الرسالة (pinMessage)
  socket.on("pinMessage", async (id, roomID, isLastMessage) => {
    try {
      io.to(roomID).emit("pinMessage", id);

      const messageToPin = await Message.findOne({ _id: id });

      if (!messageToPin) return;

      // تبديل بين التثبيت وإلغاء التثبيت
      messageToPin.pinnedAt = messageToPin?.pinnedAt ? null : Date.now(); 
      await messageToPin.save();

      if (isLastMessage) {
        io.to(roomID).emit("updateLastMsgData", {
          msgData: messageToPin,
          roomID,
        });
      }
    } catch (error) {
      console.error('❌ Error pinning message:', error);
    }
  });


  // -------------------------------------------------------------
  // 🔥 الغرف والجروبات (ROOMS & GROUPS) - مدمج ومُحسَّن بالكامل
  // -------------------------------------------------------------

  socket.on('getRooms', async (userID) => {
    try {
      const userRooms = await Room.find({ participants: { $in: userID } })
        .populate('participants', 'name lastName username avatar _id') 
        .populate({ 
            path: 'lastMessage', 
            populate: { path: 'sender', select: 'name lastName username avatar _id' }
        })
        .lean();

      const unseenCounts = await Message.aggregate([
          {
              $match: {
                  roomID: { $in: userRooms.map(r => r._id) },
                  sender: { $ne: new mongoose.Types.ObjectId(userID) },
                  seen: { $nin: [new mongoose.Types.ObjectId(userID)] },
              },
          },
          {
              $group: {
                  _id: '$roomID',
                  count: { $sum: 1 },
              },
          },
      ]);
      
      const rooms = userRooms.map(room => {
          const countData = unseenCounts.find(uc => uc._id.toString() === room._id.toString());
          socket.join(room._id.toString());
          
          return {
              ...room,
              lastMsgData: room.lastMessage,
              notSeenCount: countData ? countData.count : 0,
          };
      });

      const existingUser = onlineUsers.find((user) => user.socketID === socket.id);
      if (!existingUser) {
        onlineUsers.push({ socketID: socket.id, userID });
      }
      io.to([...socket.rooms]).emit('updateOnlineUsers', onlineUsers);

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
        .populate({
          path: 'messages',
          populate: { 
            path: 'sender', 
            model: User,
            select: 'name lastName username avatar _id'
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
          newRoom.lastMessage = newMsg._id; 
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

  // 🔥 إضافة معالج تتبع موضع التمرير في الغرفة (updateLastMsgPos)
  socket.on(
    "updateLastMsgPos",
    async ({ roomID, scrollPos, userID, shouldEmitBack = true }) => {
      try {
        const userTarget = await User.findOne({ _id: userID });

        if (!userTarget) {
          console.log(`User not found: ${userID}`);
          return;
        }

        if (!userTarget.roomMessageTrack) {
          userTarget.roomMessageTrack = [];
        }

        const isRoomExist = userTarget.roomMessageTrack.some((room) => {
          if (room.roomId.toString() === roomID) {
            room.scrollPos = scrollPos;
            return true;
          }
        });

        if (!isRoomExist) {
          userTarget.roomMessageTrack.push({ roomId: roomID, scrollPos });
        }

        if (shouldEmitBack) {
          socket.emit("updateLastMsgPos", userTarget.roomMessageTrack);
        }

        userTarget.save();
      } catch (error) {
        console.error("❌ Error updating user scroll position:", error);
      }
    }
  );

  // -------------------------------------------------------------
  // 🔥 إدارة المشرفين والأعضاء (ADMINS & MEMBERS)
  // -------------------------------------------------------------

  // 🔥 وظيفة: رؤية قائمة الأعضاء (GET ROOM MEMBERS)
  socket.on("getRoomMembers", async ({ roomID }) => {
    try {
      const room = await Room.findOne({ _id: roomID })
        .populate("participants", "name lastName username avatar _id")
        .lean(); 

      if (room) {
          socket.emit("getRoomMembers", {
            success: true,
            members: room.participants,
            admins: room.admins,
          });
      } else {
           socket.emit("getRoomMembers", { success: false, error: "Room not found" });
      }
    } catch (err) {
      console.error("❌ Error fetching room members:", err);
      socket.emit("getRoomMembers", { success: false, error: "Failed to fetch members" });
    }
  });

  // 🔥 وظيفة: تحديث المشرفين (ADD/REMOVE ADMIN)
  socket.on('updateRoomAdmins', async ({ roomID, targetUserID, action, requesterID }) => {
    try {
        const room = await Room.findById(roomID);

        if (!room) return;

        const isRequesterAdmin = room.admins.some(adminId => adminId.toString() === requesterID) || room.creator.toString() === requesterID;
        
        if (!isRequesterAdmin) {
            socket.emit('adminActionFailed', { error: 'Access denied. Must be an admin or creator.' });
            return;
        }

        let update;
        if (action === 'add') {
            update = { $addToSet: { admins: targetUserID } };
        } else if (action === 'remove') {
            update = { $pull: { admins: targetUserID } };
        } else {
            return;
        }

        const updatedRoom = await Room.findOneAndUpdate(
            { _id: roomID },
            update,
            { new: true }
        );

        if (updatedRoom) {
            io.to(roomID).emit('roomAdminsUpdated', {
                roomID: roomID,
                newAdmins: updatedRoom.admins,
                targetUser: targetUserID,
                action: action,
            });
            socket.emit('adminActionSuccess', { success: true, newAdmins: updatedRoom.admins });
        }

    } catch (error) {
        console.error('❌ Error updating room admins:', error);
        socket.emit('adminActionFailed', { error: 'Failed to update admin status.' });
    }
  });
  
  // 🔥 وظيفة: تحديث بيانات المجموعة/القناة (بما في ذلك الصورة/الاسم)
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


  // -------------------------------------------------------------
  // 🔥 المعالجات القياسية المتبقية (TYPING, DISCONNECT)
  // -------------------------------------------------------------
  
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
  
  socket.on('disconnect', () => {
    console.log('❌ Client disconnected:', socket.id);
    onlineUsers = onlineUsers.filter((data) => data.socketID !== socket.id);
    io.to([...socket.rooms]).emit('updateOnlineUsers', onlineUsers);
  });
});

// ===========================================
// 4. Start Server & Error Handling
// ===========================================

httpServer.listen(PORT, () => {
  console.log(`🚀 Socket.IO server is running on port ${PORT}`);
  console.log(`📡 CORS enabled for all origins`);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
