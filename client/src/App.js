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

    return () => {
      socket.off("user_role");
      socket.off("receive_song");
      socket.off("receive_action");
      socket.off("update_queue");
      socket.off("receive_time");
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

  const loadSong = () => {
    if (!searchQuery) return;
    socket.emit("play_song", { room, videoId: searchQuery });
    setSearchQuery("");
  };

  const addToQueue = () => {
    if (!searchQuery) return;
    socket.emit("add_to_queue", { room, videoId: searchQuery });
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

  const opts = {
    height: "0",
    width: "0",
    playerVars: { autoplay: 1, controls: 0 },
  };

  const togglePlay = () => { if (playerRef.current) playerRef.current.playVideo(); };
  const togglePause = () => { if (playerRef.current) playerRef.current.pauseVideo(); };

  return (
    <div className="App">
      {!isInRoom ? (
        <div className="joinChatContainer">
          <h3>Music Room</h3>
          <input type="text" placeholder="Room ID..." onChange={(e) => setRoom(e.target.value)} />
          <button onClick={joinRoom}>Join Room</button>
        </div>
      ) : (
        <div className="roomContainer">
          <div className="header">
            <div>
              <h2>Room: {room}</h2>
              <span className="status">Role: {role.toUpperCase()} | {syncStatus}</span>
            </div>
            <button className="leave-btn" onClick={leaveRoom}>Exit Room</button>
          </div>

          <div className="audio-interface">
            <div className={`album-art ${isPlaying ? "pulse" : ""}`}>
              {isPlaying ? "🔊" : "🎵"}
            </div>
            <div className="track-info">
              <h3>{videoId ? "Now Playing" : "No Song Selected"}</h3>
              <p>ID: {videoId}</p>
              <div className={`status-badge ${isPlaying ? "playing" : "paused"}`}>
                {videoId ? (isPlaying ? "▶ Playing" : "⏸ Paused") : "Waiting for song..."}
              </div>
            </div>
          </div>

          <div className="hidden-player">
            <YouTube
              videoId={videoId}
              opts={opts}
              onReady={onPlayerReady}
              onStateChange={handlePlayerStateChange}
            />
          </div>

          {role === "host" && (
            <div className="admin-controls">
              <div className="search-bar">
                <input 
                  type="text" 
                  placeholder="Search/Paste ID..." 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)} 
                />
                <button onClick={loadSong}>Play Now</button>
                <button onClick={addToQueue} className="secondary-btn">+ Queue</button>
              </div>
              <div className="playback-buttons">
                <button onClick={togglePlay} disabled={!videoId} className={!videoId ? "disabled" : ""}>▶ Play</button>
                <button onClick={togglePause} disabled={!videoId} className={!videoId ? "disabled" : ""}>⏸ Pause</button>
                <button onClick={playNext} disabled={queue.length === 0} className={queue.length === 0 ? "disabled" : ""}>⏭ Next</button>
              </div>
            </div>
          )}

          {role === "listener" && (
            <p style={{ marginTop: "20px", color: "#888" }}>
              {isPlaying ? "Syncing with host... 🎧" : "Host has paused the music."}
            </p>
          )}

          <div className="queue-container">
            <h3>Up Next ({queue.length})</h3>
            <ul className="queue-list">
              {queue.length === 0 ? (
                <li className="empty-queue">Queue is empty</li>
              ) : (
                queue.map((songId, index) => (
                  <li key={index}>
                    <span className="queue-index">{index + 1}.</span> {songId}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;