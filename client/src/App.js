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
  
  const [isPlaying, setIsPlaying] = useState(false);
  const playerRef = useRef(null);

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
    socket.on("receive_time", (hostTime) => {
      if (role === "host") return; // Host determines the time
      if (!playerRef.current) return;

      try {
        const myTime = playerRef.current.getCurrentTime();
        
        // 1. LATENCY COMPENSATION
        // Assume it took ~350ms for the signal to travel from Host -> Server -> You
        const estimatedHostTime = hostTime + 0.35; 

        const diff = Math.abs(myTime - estimatedHostTime);

        // 2. TIGHTER THRESHOLD (0.8 seconds)
        // If we are off by more than 0.8s, we fix it.
        // (Anything less than 0.8s is usually indistinguishable to the ear)
        if (diff > 0.8) {
          console.log(`Sync Drift: ${diff.toFixed(2)}s. Correcting...`);
          
          // Seek to the FUTURE time (where the host will be by the time we buffer)
          playerRef.current.seekTo(estimatedHostTime, true);
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
            socket.emit("time_update", { room, time: currentTime });
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
              <span className="status">Role: {role.toUpperCase()}</span>
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