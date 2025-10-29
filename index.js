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
  username: String,
  avatar: String,
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
  // ==========================================
  // 💡 التعديل: إضافة حقل fileData للصور والمستندات
  fileData: Schema.Types.Mixed, 
  // ==========================================
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

  socket.on('newMessage', async (data, callback) => {
    try {
      // ==========================================
      // 💡 التعديل: استقبال حقل fileData من العميل
      const { roomID, sender, message, replayData, voiceData = null, tempId, fileData = null } = data;
      // ==========================================
      
      const msgData = {
        sender,
        message,
        roomID,
        seen: [],
        voiceData,
        // ==========================================
        // 💡 التعديل: تخزين حقل fileData في قاعدة البيانات
        fileData, 
        // ==========================================
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
          .populate('sender', 'name username avatar _id')
          .lean();
        
        // ==========================================
        // ملاحظة: الآن populatedMsg سيحتوي على fileData، وسيتم نشره بشكل صحيح
        // ==========================================

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
    } catch (error) {
      console.error('Error in newMessage:', error);
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
    } catch (error) {
      console.error('Error in getRooms:', error);
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
          populate: { path: 'sender', model: User },
        });

      if (roomData && roomData?.type === 'private') {
        await roomData.populate('participants');
      }

      if (!roomData?._id) {
        roomData = defaultRoomData;
      }

      socket.emit('joining', roomData);
    } catch (error) {
      console.error('Error in joining:', error);
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
    } catch (error) {
      console.error('Error in createRoom:', error);
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
    } catch (error) {
      console.error('Error in seenMsg:', error);
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
        }).sort({ createdAt: -1 });

        if (lastMsg) {
          io.to(roomID).emit('updateLastMsgData', { msgData: lastMsg, roomID });
        }

        await Room.findOneAndUpdate({ _id: roomID }, { $pull: { messages: msgID } });
      }
    } catch (error) {
      console.error('Error in deleteMsg:', error);
    }
  });

  socket.on('editMessage', async ({ msgID, editedMsg, roomID }) => {
    try {
      io.to(roomID).emit('editMessage', { msgID, editedMsg, roomID });
      const updatedMsgData = await Message.findOneAndUpdate(
        { _id: msgID },
        { message: editedMsg, isEdited: true }
      ).lean();

      if (!updatedMsgData) return;

      const lastMsg = await Message.findOne({ roomID }).sort({ createdAt: -1 }).lean();

      if (lastMsg && lastMsg._id.toString() === msgID) {
        io.to(roomID).emit('updateLastMsgData', {
          roomID,
          msgData: { ...updatedMsgData, message: editedMsg },
        });
      }
    } catch (error) {
      console.error('Error in editMessage:', error);
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
    } catch (error) {
      console.error('Error updating room:', error);
      socket.emit('updateRoomDataError', { message: error.message });
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
