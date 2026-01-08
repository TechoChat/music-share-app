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

  // --- SOCKET LISTENERS ---
  useEffect(() => {
    socket.on("user_role", (role) => {
      setRole(role);
    });

    socket.on("receive_song", (id) => {
      setVideoId(id);
      setIsPlaying(true);
      
      // Force load to prevent "Paused" state on new tracks
      if (playerRef.current && playerRef.current.internalPlayer) {
        playerRef.current.internalPlayer.loadVideoById(id);
      } else if (playerRef.current && playerRef.current.loadVideoById) {
        playerRef.current.loadVideoById(id);
      }
    });

    socket.on("receive_action", (action) => {
      if (action === "play") {
        setIsPlaying(true);
        if (playerRef.current) playerRef.current.playVideo();
      }
      if (action === "pause") {
        setIsPlaying(false);
        if (playerRef.current) playerRef.current.pauseVideo();
      }
    });

    socket.on("update_queue", (newQueue) => {
      setQueue(newQueue);
    });
    
    // NEW: TIME SYNC LISTENER
    // NEW: TIME SYNC LISTENER
    socket.on("receive_time", (data) => {
      if (role === "host") return; 
      
      // Store latest packet (even if player not ready)
      latestSyncPacket.current = data;

      if (!playerRef.current) return;

      const { videoTime, sendingTimestamp } = data;

      try {
        const myTime = playerRef.current.getCurrentTime();
        
        // 1. CALCULATE GLOBAL NOW
        const now = Date.now();
        const globalNow = now + clockOffsetRef.current; // Use Ref!

        // 2. CALCULATE TIME PASSED SINCE HOST SENTIT
        const timePassedSinceSend = (globalNow - sendingTimestamp) / 1000; // seconds

        // 3. CALCULATE WHERE THE VIDEO SHOULD BE
        const expectedTime = videoTime + timePassedSinceSend;

        const diff = expectedTime - myTime;

        // 4. ADAPTIVE SYNC LOGIC
        if (Math.abs(diff) > 2.0) {
           // Major Desync: Seek
           console.log(`Major Drift (${diff.toFixed(2)}s). Seeking...`);
           playerRef.current.seekTo(expectedTime + 0.1, true); // +0.1 sync buffer
        } else if (Math.abs(diff) > 0.05) {
           // Minor Desync: Adjust Speed
           // If we are behind (diff > 0), speed up. 
           // If we are ahead (diff < 0), slow down.
           const newRate = diff > 0 ? 1.05 : 0.95;
           
           // Only change if not already set (to avoid spamming player)
           const currentRate = playerRef.current.getPlaybackRate();
           if (currentRate !== newRate) {
             console.log(`Minor Drift (${diff.toFixed(2)}s). Adjusting Rate to ${newRate}x`);
             playerRef.current.setPlaybackRate(newRate);
           }
        } else {
          // In Sync: Reset Speed
           if (playerRef.current.getPlaybackRate() !== 1) {
             playerRef.current.setPlaybackRate(1);
           }
        }

      } catch (error) {
        console.error("Sync error:", error);
      }
    });

    // NEW: SEARCH RESULTS LISTENER
    socket.on("search_results", (results) => {
      setSearchResults(results);
    });

    // NEW: ACTIVE ROOMS LISTENER
    socket.on("rooms_list", (rooms) => {
      setActiveRooms(rooms);
    });

    return () => {
      socket.off("user_role");
      socket.off("receive_song");
      socket.off("receive_action");
      socket.off("update_queue");
      socket.off("receive_time");
      socket.off("search_results");
      socket.off("rooms_list");
    };
  }, [role]); // Re-bind if role changes

  // --- HOST SYNC BROADCASTER ---
  useEffect(() => {
    let interval = null;

    if (role === "host" && isPlaying) {
      interval = setInterval(() => {
        if (playerRef.current && playerRef.current.getCurrentTime) {
          try {
            const currentTime = playerRef.current.getCurrentTime();
            // Send Current Video Time + Timestamp of sending (Global Time)
            const globalNow = Date.now() + clockOffsetRef.current; // Use Ref
            socket.emit("time_update", { 
              room, 
              videoTime: currentTime,
              sendingTimestamp: globalNow
            });
          } catch (e) { /* Player not ready */ }
        }
      }, 500); // Broadcast every second
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [role, isPlaying, room]);


  // --- ROOM ACTIONS ---

  const joinRoom = () => {
    if (room !== "") {
      socket.emit("join_room", room);
      setIsInRoom(true);
    }
  };

  const leaveRoom = () => {
    socket.emit("leave_room");
    setIsInRoom(false);
    setVideoId("");
    setRole("");
    setIsPlaying(false);
    setRoom("");
    setQueue([]);
  };

  useEffect(() => {
    const handleTabClose = (event) => { socket.emit("leave_room"); };
    window.addEventListener('beforeunload', handleTabClose);
    return () => { window.removeEventListener('beforeunload', handleTabClose); };
  }, []);

  // --- PLAYER CONTROLS ---

  // Trigger search on typing (debounced ideally, but button for now)
  const performSearch = () => {
    if (!searchQuery) return;
    socket.emit("search_song", searchQuery);
  };

  const selectSong = (song) => {
    socket.emit("play_song", { room, videoId: song.videoId });
    setSearchResults([]); // Clear results
    setSearchQuery("");
  };

  const addToQueue = (song) => {
    if (!song && !searchQuery) return; // Need song object OR simple query
    
    // If song object exists (from search), use it.
    // If manual text input, title = videoId
    const id = song ? song.videoId : searchQuery;
    const title = song ? song.title : searchQuery; 

    socket.emit("add_to_queue", { room, videoId: id, title: title });
    setSearchResults([]);
    setSearchQuery("");
  };

  const loadSong = () => {
    // Legacy direct ID load
    if (!searchQuery) return;
    socket.emit("play_song", { room, videoId: searchQuery });
    setSearchQuery("");
  };

  const playNext = () => {
    if (queue.length > 0) {
      socket.emit("play_next", { room });
    }
  };

  const handlePlayerStateChange = (event) => {
    if (role === "host") {
      const playerState = event.data;
      // 1 = Playing, 2 = Paused, 0 = Ended
      if (playerState === 1) {
        socket.emit("player_action", { room, action: "play" });
        setIsPlaying(true);
      }
      if (playerState === 2) {
        socket.emit("player_action", { room, action: "pause" });
        setIsPlaying(false);
      }
      if (playerState === 0) {
        playNext(); // Auto-play next song
      }
    }
  };

  const onPlayerReady = (event) => {
    playerRef.current = event.target;
    // If joining a room that is already playing, force play
    if (isPlaying) {
      event.target.playVideo();
    }
    
    // CHECK FOR LATE JOIN SYNC
    if (latestSyncPacket.current && role !== "host") {
       const { videoTime, sendingTimestamp } = latestSyncPacket.current;
       const now = Date.now();
       const globalNow = now + clockOffsetRef.current;
       const timePassedSinceSend = (globalNow - sendingTimestamp) / 1000;
       const expectedTime = videoTime + timePassedSinceSend;
       
       console.log(`Late Join Sync seeking to: ${expectedTime}`);
       event.target.seekTo(expectedTime + 0.2, true);
    }
  };

  // --- PROGRESS BAR LOGIC ---
  const [progress, setProgress] = useState(0); // 0-100
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    let progressInterval;
    
    if (isPlaying && playerRef.current) {
      progressInterval = setInterval(() => {
        try {
          const curr = playerRef.current.getCurrentTime();
          const dur = playerRef.current.getDuration();
          
          if (dur > 0) {
            setCurrentTime(curr);
            setDuration(dur);
            setProgress((curr / dur) * 100);
          }
        } catch (e) { }
      }, 500); // 2 pushes per second for smoother UI
    } else {
      clearInterval(progressInterval);
    }

    return () => clearInterval(progressInterval);
  }, [isPlaying]);

  const formatTime = (seconds) => {
    if (!seconds) return "0:00";
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? "0" + sec : sec}`;
  };

  // --- PLAYER UTILS ---
  const opts = {
    height: "0",
    width: "0",
    playerVars: { autoplay: 1, controls: 0 },
  };

  const togglePlay = () => { if (playerRef.current) playerRef.current.playVideo(); };
  const togglePause = () => { if (playerRef.current) playerRef.current.pauseVideo(); };

  const handleSeek = (e) => {
    if (role !== "host") return; // Only host can seek
    
    const progressBar = e.target.getBoundingClientRect();
    const clickX = e.clientX - progressBar.left;
    const percentage = clickX / progressBar.width;
    const newTime = duration * percentage;
    
    // Optimistic Update
    setProgress(percentage * 100);
    setCurrentTime(newTime);
    
    if (playerRef.current) {
      playerRef.current.seekTo(newTime, true);
      // Optional: Emit seek event if needed, but time_update usually handles sync
    }
  };

  return (
    <div className="App">
      {!isInRoom ? (
        <div className="joinChatContainer glass-panel">
          <h3>🎵 Music Share</h3>
          <input type="text" placeholder="Enter Room ID..." onChange={(e) => setRoom(e.target.value)} />
          <button onClick={joinRoom}>Join Room</button>

          {/* ACTIVE ROOMS LIST */}
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
                      <div className="room-now-playing">
                        {r.isPlaying ? "🎵 " + r.currentTitle : "Paused"}
                      </div>
                   </div>
                 ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="roomContainer glass-panel">
          <div className="header">
            <div>
              <h2>Room: {room}</h2>
              <span className="status">Role: {role.toUpperCase()} | {syncStatus}</span>
            </div>
            <button className="leave-btn" onClick={leaveRoom}>Exit</button>
          </div>

          <div className="main-grid">
            
            {/* LEFT: PLAYER SECTION */}
            <div className="player-section">
              <div className={`album-art-container`}>
                <div className={`album-art ${isPlaying ? "playing" : ""}`}>
                  {isPlaying ? "🔊" : "🎵"}
                </div>
              </div>

              <div className="song-details">
                <h3>{videoId ? "Now Playing" : "No Song Selected"}</h3>
                <p>ID: {videoId || "..."}</p>
              </div>

              <div className="progress-container">
                <div className="progress-bar" onClick={handleSeek}>
                  <div className="progress-fill" style={{ width: `${progress}%` }}></div>
                </div>
                <div className="time-labels">
                   <span>{formatTime(currentTime)}</span>
                   <span>{formatTime(duration)}</span>
                </div>
              </div>

              {role === "host" ? (
              <div className="controls-row">
                   <button className="control-btn main-play" onClick={() => isPlaying ? togglePause() : togglePlay()}>
                     {isPlaying ? "⏸" : "▶"}
                   </button>
                   <button className="control-btn" onClick={playNext}>⏭</button>
                </div>
              ) : (
                <div className="status-badge" style={{ marginTop: '20px' }}>
                  {isPlaying ? "Listening with Host 🎧" : "Host Paused"}
                </div>
              )}
            </div>

            {/* RIGHT: QUEUE & ACTIONS */}
            <div className="queue-section">
               {role === "host" && (
                 <div className="search-wrapper"> {/* Container for search + dropdown */}
                   <div className="search-container">
                      <input 
                        type="text" 
                        placeholder="Search song name..." 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)} 
                        onKeyDown={(e) => e.key === 'Enter' && performSearch()}
                      />
                      <button className="add-btn" onClick={performSearch}>Search</button>
                   </div>
                   
                   {/* DROPDOWN RESULTS */}
                   {searchResults.length > 0 && (
                     <div className="search-dropdown glass-panel">
                       {searchResults.map((song) => (
                         <div key={song.videoId} className="search-result-item" onClick={() => selectSong(song)}>
                           <img src={song.thumbnail} alt="art" />
                           <div className="result-info">
                             <p className="result-title">{song.title}</p>
                             <span className="result-meta">{song.timestamp} • {song.author}</span>
                           </div>
                           <button className="result-add-q" onClick={(e) => { e.stopPropagation(); addToQueue(song); }}>+Q</button>
                         </div>
                       ))}
                       <button className="close-search" onClick={() => setSearchResults([])}>Close Results</button>
                     </div>
                   )}
                 </div>
               )}

               <div className="queue-header">
                 <h3>Up Next ({queue.length})</h3>
               </div>
               
               <ul className="queue-list">
                 {queue.length === 0 ? (
                   <li className="empty-queue" style={{color: '#888', fontStyle: 'italic'}}>Queue is empty</li>
                 ) : (
                   queue.map((song, index) => (
                     <li key={index}>
                       <span className="queue-number">#{index + 1}</span>
                       {/* Handle both new object structure and old string structure for legacy support */}
                       {typeof song === 'object' ? song.title : song} 
                     </li>
                   ))
                 )}
               </ul>
            </div>

          </div>

          {/* HIDDEN PLAYER */}
          <div className="hidden-player" style={{display: 'none'}}>
            <YouTube
              videoId={videoId}
              opts={opts}
              onReady={onPlayerReady}
              onStateChange={handlePlayerStateChange}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;