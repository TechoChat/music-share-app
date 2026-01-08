import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import YouTube from "react-youtube";
import "./App.css";

// REPLACE WITH YOUR RENDER URL
const socket = io.connect("https://music-share-app-wv5p.onrender.com");

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
  const [clockOffset, setClockOffset] = useState(0); 
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
            const offset = t1 - t2 + latency; // t1 = server time, t2 = local receipt time. 
            // Correct formula: ClientTime + Offset = ServerTime => Offset = ServerTime - ClientTime
            // We use t2 (msg received) as "now". At t2, Server was at t1 + latency (approx).
            // Actually: 
            // Server = t1. Client = t0. Latency = (t2 - t0) / 2.
            // At moment t1 (server), Client was at t0 + latency.
            // Offset = t1 - (t0 + latency).
            
            pings.push(t1 - (t0 + latency));
            resolve();
          });
        });
      }

      // Sort and take median to avoid outliers
      pings.sort((a, b) => a - b);
      const medianOffset = pings[Math.floor(pings.length / 2)];
      
      console.log("Clock Offset Calculated:", medianOffset, "ms");
      setClockOffset(medianOffset);
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

  // --- SOCKET LISTENERS (Updated) ---
  useEffect(() => {
    socket.on("user_role", setRole);
    socket.on("receive_song", (id) => {
      setVideoId(id);
      // Removed setIsPlaying(true) - wait for explicit play/pause action or sync
      
      if (playerRef.current?.internalPlayer) playerRef.current.internalPlayer.loadVideoById(id);
      else if (playerRef.current?.loadVideoById) playerRef.current.loadVideoById(id);
    });

    socket.on("receive_action", (action) => {
      if (action === "play") { setIsPlaying(true); playerRef.current?.playVideo(); }
      if (action === "pause") { setIsPlaying(false); playerRef.current?.pauseVideo(); }
    });
    
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

    socket.on("search_results", setSearchResults);
    socket.on("rooms_list", setActiveRooms);

    // NEW EVENTS
    socket.on("update_users", setUsers);
    socket.on("receive_message", (msg) => {
        setMessages((prev) => [...prev, msg]);
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
    };
  }, [role]);

  // ... (Keep Host Sync Broadcaster, Room Actions, Player Controls, Progress Logic as is) ...
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

  const joinRoom = () => { if (room !== "") { socket.emit("join_room", room); setIsInRoom(true); } };
  const leaveRoom = () => {
    socket.emit("leave_room");
    setIsInRoom(false);
    setVideoId(""); setRole(""); setIsPlaying(false); setRoom(""); setQueue([]); setMessages([]); setUsers([]);
  };

  useEffect(() => {
    const handleTabClose = () => { socket.emit("leave_room"); };
    window.addEventListener('beforeunload', handleTabClose);
    return () => { window.removeEventListener('beforeunload', handleTabClose); };
  }, []);

  const performSearch = () => { if (searchQuery) socket.emit("search_song", searchQuery); };
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
      // Important: prevent auto-play if room is paused
      event.target.pauseVideo();
    }
    
    // SYNC for Late Joiners
    if (latestSyncPacket.current && role !== "host") {
       const { videoTime, sendingTimestamp } = latestSyncPacket.current;
       const now = Date.now() + clockOffsetRef.current;
       
       // Calculate expected time
       let expectedTime = videoTime;
       if (isPlayingRef.current) {
          expectedTime = videoTime + ((now - sendingTimestamp) / 1000);
       }
       
       console.log(`Initial Sync Seeking to: ${expectedTime} (Playing: ${isPlayingRef.current})`);
       event.target.seekTo(expectedTime, true);
    }
  };

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

  const opts = { height: "0", width: "0", playerVars: { autoplay: 0, controls: 0 } };
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
              author: "You", // Better if we had proper names, but 'You' works for sender
              message: chatMessage,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          socket.emit("send_message", msgData);
          setChatMessage("");
      }
  };

  // --- MOBILE UI STATE ---
  const [activeTab, setActiveTab] = useState("main"); // "sidebar", "main", "chat"

  return (
    <div className="App">
      {!isInRoom ? (
        // ... (Join Screen remains)
        <div className="joinChatContainer glass-panel">
          <h3>🎵 Music Share</h3>
          <input type="text" placeholder="Enter Room ID..." onChange={(e) => setRoom(e.target.value)} />
          <button onClick={joinRoom}>Join Room</button>
          
          {activeRooms.length > 0 && (
            <div className="active-rooms-container">
              <h4>Active Rooms</h4>
              <div className="active-rooms-grid">
                 {activeRooms.map((r) => (
                   <div key={r.roomId} className="room-card" onClick={() => { setRoom(r.roomId); joinRoom(); }}>
                      <div className="room-card-header">
                        <span className="room-id">Room: {r.roomId}</span>
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
                      </div>
                      <div className="search-results-floating">
                        {searchResults.map((song) => (
                          <div key={song.videoId} className="search-item" onClick={() => selectSong(song)}>
                            <img src={song.thumbnail} alt="" />
                            <div className="search-info">
                                <p>{song.title}</p>
                                <span>{song.author}</span>
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
                    {messages.map((msg, i) => (
                        <div key={i} className={`chat-bubble ${msg.author === "You" ? "mine" : ""}`}>
                            <div className="chat-meta">
                                {msg.author} <span className="chat-time">{msg.time}</span>
                            </div>
                            <div className="chat-text">{msg.message}</div>
                        </div>
                    ))}
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

            <div className="hidden-player" style={{display:'none'}}>
                <YouTube videoId={videoId} opts={opts} onReady={onPlayerReady} onStateChange={handlePlayerStateChange} />
            </div>
        </div>
      )}
    </div>
  );
}

export default App;