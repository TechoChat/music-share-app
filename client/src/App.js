import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import YouTube from "react-youtube";
import "./App.css";

// REPLACE WITH YOUR RENDER URL
const socket = io.connect("https://music-share-app-wv5p.onrender.com");

const animals = ["Panda", "Giraffe", "Lion", "Tiger", "Koala", "Penguin", "Eagle", "Falcon", "Otter", "Fox"];
const adjectives = ["Cool", "Happy", "Swift", "Brave", "Calm", "Fierce", "Lucky", "Wise", "Epic", "Neon"];

const generateName = () => {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    return `${adj} ${animal}`;
};

function App() {
  const [room, setRoom] = useState("");
  const [isInRoom, setIsInRoom] = useState(false);
  const [role, setRole] = useState("");
  const [videoId, setVideoId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]); // Array of search results
  const [activeRooms, setActiveRooms] = useState([]); // Array of active rooms from server
  const [queue, setQueue] = useState([]);
  
  // SYNC STATE
  const clockOffsetRef = useRef(0); // Ref to avoid stale closures in socket usage
  const latestSyncPacket = useRef(null); // Store last packet for late-join catchup

  const [syncStatus, setSyncStatus] = useState("Syncing..."); 

  const [isPlaying, setIsPlaying] = useState(false);
  const playerRef = useRef(null);

  // --- CLOCK SYNCHRONIZATION (NTP-like) ---
  useEffect(() => {
    const syncClock = async () => {
      const pings = [];
      const PING_COUNT = 10;

      for (let i = 0; i < PING_COUNT; i++) {
        const t0 = Date.now();
        await new Promise(resolve => {
          socket.emit("sync_time", {}, (response) => {
            const t1 = response.serverTime;
            const t2 = Date.now();
            const latency = (t2 - t0) / 2;
            
            pings.push(t1 - (t0 + latency));
            resolve();
          });
        });
      }

      // Sort and take median to avoid outliers
      pings.sort((a, b) => a - b);
      const medianOffset = pings[Math.floor(pings.length / 2)];
      
      console.log("Clock Offset Calculated:", medianOffset, "ms");
      clockOffsetRef.current = medianOffset; // Update Ref
      setSyncStatus(`Synced (Offset: ${Math.round(medianOffset)}ms)`);
    };

    syncClock();
  }, []);

  // --- NEW STATE FOR CHAT & USERS ---
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [chatMessage, setChatMessage] = useState("");
  const chatEndRef = useRef(null);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const [isSearching, setIsSearching] = useState(false); // NEW: Search loading state

  // --- SOCKET LISTENERS (Updated) ---
  useEffect(() => {
    socket.on("user_role", (r) => {
        setRole(r);
        setIsInRoom(true); // Only enter when role is assigned
    });
    
    socket.on("receive_song", (id) => {
      setVideoId(id);
      setIsPlaying(true); // Optimistically set playing state

      // Fix: Force play after loading
      if (playerRef.current) {
         const player = playerRef.current.internalPlayer || playerRef.current;
         if (player && player.loadVideoById) {
             // Object syntax automatically plays by default
             player.loadVideoById({videoId: id});
         }
      }
    });

    socket.on("receive_action", (action) => {
      if (action === "play") { setIsPlaying(true); playerRef.current?.playVideo(); }
      if (action === "pause") { setIsPlaying(false); playerRef.current?.pauseVideo(); }
    });
    
    // ... (keep initial_sync, update_queue, receive_time) ...
    // NEW: INITIAL SYNC FOR JOINERS
    socket.on("initial_sync", (data) => {
       console.log("Initial Sync Data:", data);
       if (data.videoId) setVideoId(data.videoId);
       setIsPlaying(data.isPlaying); // Set correct state immediately
       if (data.queue) setQueue(data.queue);
       
       // Store sync data for onPlayerReady
       latestSyncPacket.current = { 
         videoTime: data.videoTime, 
         sendingTimestamp: data.sendingTimestamp 
       };
    });

    socket.on("update_queue", setQueue);
    
    // TIME SYNC
    socket.on("receive_time", (data) => {
      if (role === "host") return; 
      latestSyncPacket.current = data;
      if (!playerRef.current) return;
      const { videoTime, sendingTimestamp } = data;
      try {
        const myTime = playerRef.current.getCurrentTime();
        const globalNow = Date.now() + clockOffsetRef.current;
        const timePassedSinceSend = (globalNow - sendingTimestamp) / 1000;
        const expectedTime = videoTime + timePassedSinceSend;
        const diff = expectedTime - myTime;

        if (Math.abs(diff) > 2.0) playerRef.current.seekTo(expectedTime + 0.1, true);
        else if (Math.abs(diff) > 0.05) {
          const newRate = diff > 0 ? 1.05 : 0.95;
          if (playerRef.current.getPlaybackRate() !== newRate) playerRef.current.setPlaybackRate(newRate);
        } else if (playerRef.current.getPlaybackRate() !== 1) playerRef.current.setPlaybackRate(1);
      } catch (e) { }
    });

    socket.on("search_results", (results) => {
        setSearchResults(results);
        setIsSearching(false); // Stop loading
    });
    
    socket.on("rooms_list", setActiveRooms);

    // NEW EVENTS
    socket.on("update_users", setUsers);
    
    socket.on("receive_message", (msg) => {
        setMessages((prev) => [...prev, msg]);
    });
    
    // Error Handler for invalid room
    socket.on("error", (msg) => {
        alert(msg);
        setIsInRoom(false);
        setRoom("");
    });

    return () => {
      socket.off("user_role");
      socket.off("receive_song");
      socket.off("receive_action");
      socket.off("initial_sync");
      socket.off("update_queue");
      socket.off("receive_time");
      socket.off("search_results");
      socket.off("rooms_list");
      socket.off("update_users");
      socket.off("receive_message");
      socket.off("error");
    };
  }, [role]);

  // --- HOST SYNC BROADCASTER ---
  useEffect(() => {
    let interval = null;
    if (role === "host" && isPlaying) {
      interval = setInterval(() => {
        if (playerRef.current && playerRef.current.getCurrentTime) {
          try {
            const currentTime = playerRef.current.getCurrentTime();
            const globalNow = Date.now() + clockOffsetRef.current;
            socket.emit("time_update", { room, videoTime: currentTime, sendingTimestamp: globalNow });
          } catch (e) { }
        }
      }, 500);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [role, isPlaying, room]);

  // --- NAME & ROOM LOGIC ---
  const [username, setUsername] = useState("");
  const [otp, setOtp] = useState(["", "", "", ""]);
  const inputRefs = [useRef(), useRef(), useRef(), useRef()];

  useEffect(() => {
     const savedName = localStorage.getItem("music_share_name");
     if (savedName) setUsername(savedName);
     else {
         const newName = generateName();
         setUsername(newName);
         localStorage.setItem("music_share_name", newName);
     }
  }, []);

  const regenerateName = () => {
      const newName = generateName();
      setUsername(newName);
      localStorage.setItem("music_share_name", newName);
  };

  const handleOtpChange = (index, value) => {
      if (isNaN(value)) return;
      const newOtp = [...otp];
      newOtp[index] = value;
      setOtp(newOtp);

      if (value !== "" && index < 3) {
          inputRefs[index + 1].current.focus();
      }
  };

  const handleOtpKeyDown = (index, e) => {
      if (e.key === "Backspace" && otp[index] === "" && index > 0) {
          inputRefs[index - 1].current.focus();
      }
      if (e.key === 'Enter') joinWithOtp();
  };

  const generateRoomId = () => {
      return Math.floor(1000 + Math.random() * 9000).toString();
  };

  const createRoom = () => {
      const newRoomId = generateRoomId();
      setRoom(newRoomId);
      socket.emit("join_room", { roomId: newRoomId, username, create: true });
  };

  const joinWithOtp = () => {
      const enteredRoom = otp.join("");
      if (enteredRoom.length === 4) {
          setRoom(enteredRoom);
          socket.emit("join_room", { roomId: enteredRoom, username, create: false });
      } else {
          alert("Please enter a 4-digit Room ID");
      }
  };

  const joinExistingRoom = (rId) => {
      setRoom(rId);
      socket.emit("join_room", { roomId: rId, username, create: false });
  };
  
  const leaveRoom = () => {
    socket.emit("leave_room");
    setIsInRoom(false);
    setVideoId(""); setRole(""); setIsPlaying(false); setRoom(""); setQueue([]); setMessages([]); setUsers([]);
  };

  const performSearch = () => { 
      if (searchQuery) {
          setIsSearching(true);
          setSearchResults([]); // Clear previous results immediately
          socket.emit("search_song", searchQuery); 
      }
  };
  
  // ... (keep selectSong, addToQueue, playNext, player logic) ...
  const selectSong = (song) => {
    socket.emit("play_song", { room, videoId: song.videoId, title: song.title });
    setSearchResults([]); setSearchQuery("");
  };
  const addToQueue = (song) => {
    if (!song && !searchQuery) return;
    const id = song ? song.videoId : searchQuery;
    const title = song ? song.title : searchQuery; 
    socket.emit("add_to_queue", { room, videoId: id, title: title });
    setSearchResults([]); setSearchQuery("");
  };
  const playNext = () => { if (queue.length > 0) socket.emit("play_next", { room }); };

  // Ref for immediate state access in callbacks
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const handlePlayerStateChange = (event) => {
    // Force play if stuck in CUED state and we should be playing
    if (event.data === 5 && isPlayingRef.current) {
        event.target.playVideo();
    }

    if (role === "host") {
      const ps = event.data;
      if (ps === 1) { socket.emit("player_action", { room, action: "play" }); setIsPlaying(true); }
      if (ps === 2) { socket.emit("player_action", { room, action: "pause" }); setIsPlaying(false); }
      if (ps === 0) playNext();
    }
  };

  const onPlayerReady = (event) => {
    playerRef.current = event.target;
    
    // Auto-play / Pause logic based on room state (Use REF for fresh value)
    if (isPlayingRef.current) {
      event.target.playVideo();
    } else {
      event.target.pauseVideo();
    }
    
    // SYNC for Late Joiners
    if (latestSyncPacket.current && role !== "host") {
       const { videoTime, sendingTimestamp } = latestSyncPacket.current;
       const now = Date.now() + clockOffsetRef.current;
       
       let expectedTime = videoTime;
       if (isPlayingRef.current) {
          expectedTime = videoTime + ((now - sendingTimestamp) / 1000);
       }
       event.target.seekTo(expectedTime, true);
    }
  };
  
  // --- MOBILE UI STATE ---
  const [activeTab, setActiveTab] = useState("main"); // "sidebar", "main", "chat"

  // Progress Bar Logic
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    let progressInterval;
    if (isPlaying && playerRef.current) {
      progressInterval = setInterval(() => {
        try {
           const curr = playerRef.current.getCurrentTime();
           const dur = playerRef.current.getDuration();
           if (dur > 0) { setCurrentTime(curr); setDuration(dur); setProgress((curr / dur) * 100); }
        } catch (e) { }
      }, 500);
    } else clearInterval(progressInterval);
    return () => clearInterval(progressInterval);
  }, [isPlaying]);

  const formatTime = (seconds) => {
    if (!seconds) return "0:00";
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? "0" + sec : sec}`;
  };

  // Ensure playsinline is active for iOS
  const opts = { height: "0", width: "0", playerVars: { autoplay: 0, controls: 0, playsinline: 1 } };
  const togglePlay = () => { playerRef.current?.playVideo(); };
  const togglePause = () => { playerRef.current?.pauseVideo(); };

  const handleSeek = (e) => {
    if (role !== "host") return;
    const bar = e.target.getBoundingClientRect();
    const pct = (e.clientX - bar.left) / bar.width;
    const newTime = duration * pct;
    setProgress(pct * 100); setCurrentTime(newTime);
    playerRef.current?.seekTo(newTime, true);
  };
  
  // --- CHAT LOGIC ---
  const sendMessage = () => {
      if (chatMessage !== "") {
          const msgData = {
              room,
              author: username, // Use actual username
              senderId: socket.id, // Send ID for identification
              message: chatMessage,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          socket.emit("send_message", msgData);
          setChatMessage("");
      }
  };

  return (
    <div className="App">
      {!isInRoom ? (
        <div className="joinChatContainer glass-panel">
          <h3>🎵 Music Share</h3>
          
          {/* NAME GENERATOR */}
          <div className="name-section">
              <span className="hello-text">Hello,</span>
              <div className="name-display">
                  <span className="user-name-text">{username}</span>
                  <button className="regen-btn" onClick={regenerateName} title="New Name">🔄</button>
              </div>
          </div>

          {/* CREATE ROOM */}
          <button className="create-room-btn" onClick={createRoom}>
              ✨ Create New Room
          </button>

          <div className="divider"><span>OR JOIN</span></div>

          {/* OTP INPUTS */}
          <div className="otp-container">
              {otp.map((digit, i) => (
                  <input
                    key={i}
                    ref={inputRefs[i]}
                    type="text"
                    maxLength="1"
                    className="otp-input"
                    value={digit}
                    onChange={(e) => handleOtpChange(i, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(i, e)}
                  />
              ))}
          </div>

          <button className="join-btn" onClick={joinWithOtp}>
              Join Room
          </button>
          
          {activeRooms.length > 0 && (
            <div className="active-rooms-container">
              <h4>Active Rooms</h4>
              <div className="active-rooms-grid">
                 {activeRooms.map((r) => (
                   <div key={r.roomId} className="room-card" onClick={() => joinExistingRoom(r.roomId)}>
                      <div className="room-card-header">
                        <span className="room-id">#{r.roomId}</span>
                        <span className="user-count">👥 {r.userCount}</span>
                      </div>
                      <div className="room-now-playing">{r.isPlaying ? "🎵 " + r.currentTitle : "Paused"}</div>
                   </div>
                 ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* --- DASHBOARD LAYOUT --- */
        <div className={`dashboard-container ${activeTab}`}>
            
            {/* MOBILE HEADER (Only visible on mobile) */}
            <div className="mobile-nav">
               <button className={activeTab === "sidebar" ? "active" : ""} onClick={() => setActiveTab("sidebar")}>👥 Users</button>
               <button className={activeTab === "main" ? "active" : ""} onClick={() => setActiveTab("main")}>🎵 Queue</button>
               <button className={activeTab === "chat" ? "active" : ""} onClick={() => setActiveTab("chat")}>💬 Chat</button>
            </div>

            {/* SIDEBAR */}
            <div className="sidebar">
                <div className="sidebar-header">
                    <h3># Room {room}</h3>
                    <div className="sidebar-status">{role.toUpperCase()}</div>
                </div>

                <div className="sidebar-section">
                    <h4>Connected Users ({users.length})</h4>
                    <ul className="user-list">
                        {users.map((u, i) => (
                            <li key={i} className="user-item">
                                <div className="user-avatar">{u.name.charAt(0)}</div>
                                <span>{u.name}</span>
                                {u.id === socket.id && <span className="you-tag">(You)</span>}
                            </li>
                        ))}
                    </ul>
                </div>
                
                <button className="sidebar-exit-btn" onClick={leaveRoom}>Exit Room</button>
            </div>

            {/* MAIN CONTENT (Queue & Search) */}
            <div className="main-content">
                {role === "host" && (
                  <div className="search-bar-wrapper">
                      <div className="custom-search-input">
                         <span>🔍</span>
                         <input 
                           type="text" 
                           placeholder="Search songs..." 
                           value={searchQuery}
                           onChange={(e) => setSearchQuery(e.target.value)} 
                           onKeyDown={(e) => e.key === 'Enter' && performSearch()}
                         />
                         {isSearching && <div className="spinner-small"></div>}
                         {(searchResults.length > 0 || searchQuery.length > 0) && (
                             <button className="close-search-btn" onClick={() => { setSearchResults([]); setSearchQuery(""); }}>✕</button>
                         )}
                      </div>
                      <div className="search-results-floating">
                        {searchResults.map((song) => (
                          <div key={song.videoId} className="search-item" onClick={() => selectSong(song)}>
                            <img src={song.thumbnail} alt="" />
                            <div className="search-info">
                                <p>{song.title}</p>
                                <span className="search-author">{song.author}</span>
                            </div>
                            <button onClick={(e) => { e.stopPropagation(); addToQueue(song); }}>+ Add</button>
                          </div>
                        ))}
                      </div>
                  </div>
                )}
                
                <div className="queue-list-container">
                    <h2 className="section-title">Up Next</h2>
                    {queue.length === 0 ? (
                        <div className="empty-state">Queue is empty. Search to add songs!</div>
                    ) : (
                        queue.map((song, index) => (
                            <div key={index} className="queue-row">
                                <span className="q-idx">{index + 1}</span>
                                <div className="q-info">
                                    <p>{typeof song === 'object' ? song.title : song}</p>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* CHAT PANEL */}
            <div className="chat-panel">
                <div className="chat-header">Chat</div>
                <div className="chat-messages">
                    {messages.map((msg, i) => {
                        const isMine = msg.senderId === socket.id || msg.author === "You"; // Fallback for legacy
                        return (
                            <div key={i} className={`chat-bubble ${isMine ? "mine" : ""}`}>
                                <div className="chat-meta">
                                    {isMine ? "You" : msg.author} <span className="chat-time">{msg.time}</span>
                                </div>
                                <div className="chat-text">{msg.message}</div>
                            </div>
                        );
                    })}
                    <div ref={chatEndRef}></div>
                </div>
                <div className="chat-input-area">
                    <input 
                        type="text" 
                        placeholder="Say hello..." 
                        value={chatMessage} 
                        onChange={(e) => setChatMessage(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && sendMessage()} 
                    />
                </div>
            </div>

            {/* BOTTOM PLAYER BAR */}
            <div className="player-bar">
                <div className="pb-left">
                    <div className="pb-art">
                        {isPlaying ? "💿" : "🎵"}
                    </div>
                    <div className="pb-info">
                        <h4>{videoId ? (queue[0]?.title || "Now Playing") : "No Song"}</h4>
                        <p>{syncStatus}</p>
                    </div>
                </div>

                <div className="pb-center">
                    <div className="pb-controls">
                        <button className="pb-btn" onClick={() => role === "host" && (isPlaying ? togglePause() : togglePlay())}>
                            {isPlaying ? "⏸" : "▶"}
                        </button>
                        <button className="pb-btn" onClick={() => role === "host" && playNext()}>⏭</button>
                    </div>
                    <div className="pb-progress-row">
                         <span>{formatTime(currentTime)}</span>
                         <div className="pb-progress-track" onClick={handleSeek}>
                             <div className="pb-progress-fill" style={{width: `${progress}%`}}></div>
                         </div>
                         <span>{formatTime(duration)}</span>
                    </div>
                </div>

                <div className="pb-right">
                    {/* Volume or other controls could go here */}
                </div>
            </div>

            <div className="hidden-player" style={{position:'absolute', top:'-9999px', opacity: 0, pointerEvents: 'none'}}>
                <YouTube videoId={videoId} opts={opts} onReady={onPlayerReady} onStateChange={handlePlayerStateChange} />
            </div>
        </div>
      )}
    </div>
  );
}

export default App;