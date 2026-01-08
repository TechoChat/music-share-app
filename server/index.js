const express = require("express");
const app = express();
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

app.use(cors());

const server = http.createServer(app);

// CORS CONFIGURATION
const io = new Server(server, {
  cors: {
    // Whitelist both your local testing URL and your live production URL
    origin: ["http://localhost:3000", "https://music.techochat.com"],
    methods: ["GET", "POST"],
  },
});

// Memory storage
const rooms = {};

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  socket.on("join_room", (roomId) => {
    // 1. ZOMBIE ROOM CLEANUP
    if (rooms[roomId]) {
      const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
      if (roomSize === 0) {
        console.log(`⚠️ Cleaning up empty room: ${roomId}`);
        delete rooms[roomId];
      }
    }

    socket.join(roomId);
    socket.currentRoom = roomId;

    // 2. CHECK IF ROOM EXISTS
    if (!rooms[roomId]) {
      // Create new room
      rooms[roomId] = { 
        host: socket.id, 
        currentVideo: null, 
        isPlaying: false,
        queue: [] // Queue Array
      };
      socket.emit("user_role", "host");
      console.log(`✅ Room ${roomId} created. Host: ${socket.id}`);
    } else {
      // Room exists... BUT IS THE HOST ALIVE?
      const currentHostId = rooms[roomId].host;
      const isHostAlive = io.sockets.sockets.get(currentHostId);

      if (!currentHostId || !isHostAlive) {
        console.log(`👻 Ghost Host detected in ${roomId}. Promoting ${socket.id}`);
        rooms[roomId].host = socket.id;
        socket.emit("user_role", "host");
      } else {
        socket.emit("user_role", "listener");
        console.log(`🎧 User ${socket.id} joined ${roomId} as Listener`);
      }

      // Sync playback state
      if (rooms[roomId].currentVideo) {
        socket.emit("receive_song", rooms[roomId].currentVideo);
      }
      if (rooms[roomId].queue) {
        socket.emit("update_queue", rooms[roomId].queue);
      }
      if (rooms[roomId].isPlaying) {
         socket.emit("receive_action", "play");
      }
    }
  });

  // --- PLAYBACK HANDLERS ---

  socket.on("play_song", (data) => {
    if (rooms[data.room]) {
      rooms[data.room].currentVideo = data.videoId;
      rooms[data.room].isPlaying = true;
      
      // Send Song ID
      io.to(data.room).emit("receive_song", data.videoId);
      // Force Play Action
      io.to(data.room).emit("receive_action", "play");
    }
  });

  socket.on("player_action", (data) => {
    if (rooms[data.room]) {
      rooms[data.room].isPlaying = (data.action === "play");
      socket.to(data.room).emit("receive_action", data.action);
    }
  });

  // --- SYNC HANDLER (NEW) ---
  socket.on("time_update", (data) => {
    if (rooms[data.room]) {
      // Broadcast host's timestamp to everyone else
      socket.to(data.room).emit("receive_time", {
        videoTime: data.videoTime,
        sendingTimestamp: data.sendingTimestamp
      });
    }
  });

  // --- QUEUE HANDLERS ---

  socket.on("add_to_queue", (data) => {
    if (rooms[data.room]) {
      rooms[data.room].queue.push(data.videoId);
      io.to(data.room).emit("update_queue", rooms[data.room].queue);
    }
  });

  socket.on("play_next", (data) => {
    const room = rooms[data.room];
    if (room && room.queue.length > 0) {
      const nextSong = room.queue.shift(); // Remove first song
      room.currentVideo = nextSong;
      room.isPlaying = true;
      
      io.to(data.room).emit("receive_song", nextSong);
      io.to(data.room).emit("update_queue", room.queue);
      io.to(data.room).emit("receive_action", "play");
    }
  });
  
  // --- HANDLE LEAVING ---
  const handleLeave = () => {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms[roomId]) return;

    socket.leave(roomId);
    
    if (rooms[roomId].host === socket.id) {
       rooms[roomId].host = null;
       console.log(`❌ Host ${socket.id} left room ${roomId}`);
       
       const remainingUsers = io.sockets.adapter.rooms.get(roomId);
       if (remainingUsers && remainingUsers.size > 0) {
         const newHostId = [...remainingUsers][0];
         rooms[roomId].host = newHostId;
         io.to(newHostId).emit("user_role", "host");
         console.log(`👑 New Host assigned: ${newHostId}`);
       } else {
         delete rooms[roomId];
         console.log(`🗑️ Room ${roomId} deleted (Empty).`);
       }
    }
  };

  socket.on("leave_room", () => {
    handleLeave();
    socket.currentRoom = null;
  });

  // --- NTP SYNC HANDLER ---
  socket.on("sync_time", (data, callback) => {
    // Client sends their local time (t0). We return server time (t1).
    // Client receives it at (t2).
    // Latency = (t2 - t0) / 2
    // ClockOffset = t1 - t0 - Latency
    callback({
      serverTime: Date.now()
    });
  });

  socket.on("disconnect", () => {
    handleLeave();
    console.log("User Disconnected", socket.id);
  });
});

const port = process.env.PORT || 3001;
server.listen(port, () => {
  console.log(`SERVER RUNNING ON PORT ${port}`);
});