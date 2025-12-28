const express = require("express");
const app = express();
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
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
    // If the room exists in memory but has NO connections, delete it.
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
      rooms[roomId] = { host: socket.id, currentVideo: null, isPlaying: false, queue: [] };
      socket.emit("user_role", "host");
      console.log(`✅ Room ${roomId} created. Host: ${socket.id}`);
    } else {
      // Room exists... BUT IS THE HOST ALIVE?
      const currentHostId = rooms[roomId].host;
      // socket.io v4 method to check if a socket ID is actually connected
      const isHostAlive = io.sockets.sockets.get(currentHostId);

      if (!currentHostId || !isHostAlive) {
        // HOST IS A GHOST! Usurp the throne.
        console.log(`👻 Ghost Host detected in ${roomId}. Promoting ${socket.id}`);
        rooms[roomId].host = socket.id;
        socket.emit("user_role", "host");
      } else {
        // Host is alive and well. You are a listener.
        socket.emit("user_role", "listener");
        console.log(`🎧 User ${socket.id} joined ${roomId} as Listener`);
      }

      socket.emit("update_queue", rooms[roomId].queue);

      // Sync playback state
      if (rooms[roomId].currentVideo) {
        socket.emit("receive_song", rooms[roomId].currentVideo);
      }
      if (rooms[roomId].isPlaying) {
         socket.emit("receive_action", "play");
      }
    }
  });

  socket.on("play_song", (data) => {
    if (rooms[data.room]) {
      rooms[data.room].currentVideo = data.videoId;
      rooms[data.room].isPlaying = true; // Set internal state to TRUE
      
      // 1. Send the song ID
      io.to(data.room).emit("receive_song", data.videoId);
      
      // 2. FORCE the play action immediately after
      io.to(data.room).emit("receive_action", "play");
    }
  });

  socket.on("add_to_queue", (data) => {
    if (rooms[data.room]) {
      rooms[data.room].queue.push(data.videoId);
      io.to(data.room).emit("update_queue", rooms[data.room].queue);
    }
  });

  socket.on("play_next", (data) => {
    const room = rooms[data.room];
    if (room && room.queue.length > 0) {
      const nextSong = room.queue.shift();
      room.currentVideo = nextSong;
      room.isPlaying = true;
      
      // 1. Update the song for everyone
      io.to(data.room).emit("receive_song", nextSong);
      
      // 2. Update the queue for everyone
      io.to(data.room).emit("update_queue", room.queue);
      
      // 3. (Optional) Force play action, though loadVideoById usually handles it
      io.to(data.room).emit("receive_action", "play");
    }
  });

  socket.on("player_action", (data) => {
    if (rooms[data.room]) {
      rooms[data.room].isPlaying = (data.action === "play");
      socket.to(data.room).emit("receive_action", data.action);
    }
  });
  
  // --- HANDLE LEAVING ---
  const handleLeave = () => {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms[roomId]) return;

    socket.leave(roomId);
    
    // If the person leaving was the HOST
    if (rooms[roomId].host === socket.id) {
       rooms[roomId].host = null; // Unset host immediately
       console.log(`❌ Host ${socket.id} left room ${roomId}`);
       
       // Try to find a new host from remaining users
       const remainingUsers = io.sockets.adapter.rooms.get(roomId);
       if (remainingUsers && remainingUsers.size > 0) {
         const newHostId = [...remainingUsers][0]; // Pick first available user
         rooms[roomId].host = newHostId;
         io.to(newHostId).emit("user_role", "host"); // Notify them
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

  socket.on("disconnect", () => {
    handleLeave();
    console.log("User Disconnected", socket.id);
  });
});

const port = process.env.PORT || 3001;

server.listen(port, () => {
  console.log(`SERVER RUNNING ON PORT ${port}`);
});