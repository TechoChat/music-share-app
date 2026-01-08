const express = require("express");
const app = express();
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const ytSearch = require("yt-search"); // Import yt-search

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

  // Broadcast active rooms to everyone
  const broadcastRooms = () => {
    const activeRooms = [];
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const userCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;
      if (userCount > 0) {
        activeRooms.push({
          roomId,
          currentVideo: room.currentVideo,
          currentTitle: room.currentTitle || "Nothing Playing",
          userCount,
          isPlaying: room.isPlaying
        });
      }
    }
    io.emit("rooms_list", activeRooms);
  };

  io.on("connection", (socket) => {
    console.log(`User Connected: ${socket.id}`);
    
    // Send initial list
    broadcastRooms();

const animals = ["Panda", "Giraffe", "Lion", "Tiger", "Koala", "Penguin", "Eagle", "Falcon"];
const adjectives = ["Cool", "Happy", "Swift", "Brave", "Calm", "Fierce", "Lucky", "Wise"];

const generateName = () => {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    return `${adj} ${animal}`;
};

// ... existing code ...

    socket.on("join_room", (roomId) => {
    // 1. ZOMBIE ROOM CLEANUP
    if (rooms[roomId]) {
      const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
      if (roomSize === 0) {
        console.log(`⚠️ Cleaning up empty room: ${roomId}`);
        delete rooms[roomId];
        broadcastRooms(); // Update list
      }
    }

    socket.join(roomId);
    socket.currentRoom = roomId;
    
    // Generate User Name
    socket.username = generateName();

    // 2. CHECK IF ROOM EXISTS
    if (!rooms[roomId]) {
      // Create new room
      rooms[roomId] = { 
        host: socket.id, 
        currentVideo: null, 
        currentTitle: null,
        currentTitle: null,
        isPlaying: false,
        lastKnownTime: 0,
        lastTimestamp: 0,
        queue: [],
        users: [] // Track users explicitly
      };
      socket.emit("user_role", "host");
      console.log(`✅ Room ${roomId} created. Host: ${socket.id}`);
      broadcastRooms(); 
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
      // NEW: Send consolidated state to new joiner
      socket.emit("initial_sync", {
        videoId: rooms[roomId].currentVideo,
        isPlaying: rooms[roomId].isPlaying,
        videoTime: rooms[roomId].lastKnownTime || 0,
        sendingTimestamp: rooms[roomId].lastTimestamp || Date.now(),
        queue: rooms[roomId].queue
      });
    }
    
    // ADD USER TO LIST
    rooms[roomId].users.push({ id: socket.id, name: socket.username });
    io.to(roomId).emit("update_users", rooms[roomId].users); // Broadcast new list

    broadcastRooms(); // Update user/count
  });

  // --- PLAYBACK HANDLERS ---

  socket.on("play_song", (data) => {
    if (rooms[data.room]) {
      rooms[data.room].currentVideo = data.videoId;
      rooms[data.room].currentTitle = data.title || data.videoId; // Store title
      rooms[data.room].isPlaying = true;
      rooms[data.room].lastKnownTime = 0; // Reset time on new song
      rooms[data.room].lastTimestamp = Date.now();
      
      // Send Song ID
      io.to(data.room).emit("receive_song", data.videoId);
      // Force Play Action
      io.to(data.room).emit("receive_action", "play");
      broadcastRooms(); // Update song info
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
      // Store on server for late joiners
      rooms[data.room].lastKnownTime = data.videoTime;
      rooms[data.room].lastTimestamp = data.sendingTimestamp;

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
      // Store object { videoId, title }
      rooms[data.room].queue.push({ videoId: data.videoId, title: data.title || data.videoId });
      io.to(data.room).emit("update_queue", rooms[data.room].queue);
    }
  });

  socket.on("play_next", (data) => {
    const room = rooms[data.room];
    if (room && room.queue.length > 0) {
      const nextSong = room.queue.shift(); // This is now an object
      room.currentVideo = nextSong.videoId;
      room.currentTitle = nextSong.title; // Update title
      room.isPlaying = true;
      
      io.to(data.room).emit("receive_song", nextSong.videoId); // Still just emit ID to players
      io.to(data.room).emit("update_queue", room.queue);
      io.to(data.room).emit("receive_action", "play");
      broadcastRooms(); // Update song info
    }
  });
  socket.on("search_song", async (query) => {
    try {
      const r = await ytSearch(query);
      const videos = r.videos.slice(0, 10).map(v => ({
        title: v.title,
        videoId: v.videoId,
        timestamp: v.timestamp,
        thumbnail: v.thumbnail,
        author: v.author.name
      }));
      socket.emit("search_results", videos);
    } catch (e) {
      console.error("Search error:", e);
      socket.emit("search_results", []);
    }
  });
  
  // --- CHAT MSG HANDLER ---
  socket.on("send_message", (data) => {
      // data: { room, message, author, time }
      io.to(data.room).emit("receive_message", data);
  });
  
  // --- HANDLE LEAVING ---
  const handleLeave = () => {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms[roomId]) return;

    socket.leave(roomId);
    
    // REMOVE USER FROM LIST
    rooms[roomId].users = rooms[roomId].users.filter(u => u.id !== socket.id);
    io.to(roomId).emit("update_users", rooms[roomId].users); // Update remaining users
    
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