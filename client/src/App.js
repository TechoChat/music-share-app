import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import YouTube from "react-youtube";
import "./App.css";

const socket = io.connect("http://localhost:3001");

function App() {
  const [room, setRoom] = useState("");
  const [isInRoom, setIsInRoom] = useState(false);
  const [role, setRole] = useState("");
  const [videoId, setVideoId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [queue, setQueue] = useState([]); // Queue state
  
  // UI state for play/pause
  const [isPlaying, setIsPlaying] = useState(false);

  const playerRef = useRef(null);

  useEffect(() => {
    socket.on("user_role", (role) => {
      setRole(role);
    });

    socket.on("receive_song", (id) => {
      setVideoId(id); // Update UI state
      setIsPlaying(true); // Ensure UI shows "Playing"
      
      // CRITICAL FIX: Directly tell the player to load the new video
      // This bypasses React's render delay and ensures smooth transition
      if (playerRef.current && playerRef.current.internalPlayer) {
        // .internalPlayer is specific to react-youtube to access raw API
        playerRef.current.internalPlayer.loadVideoById(id);
      } 
      // Fallback for standard ref usage
      else if (playerRef.current && typeof playerRef.current.loadVideoById === "function") {
         playerRef.current.loadVideoById(id);
      }
    });
    
    socket.on("receive_action", (action) => {
      if (action === "play") {
        setIsPlaying(true);
        if (playerRef.current) {
          playerRef.current.playVideo();
        }
      }
      if (action === "pause") {
        setIsPlaying(false);
        if (playerRef.current) {
          playerRef.current.pauseVideo();
        }
      }
    });
    
    // Listen for queue updates from server
    socket.on("update_queue", (newQueue) => {
      setQueue(newQueue);
    });
    
    // Cleanup on unmount
    return () => {
      socket.off("user_role");
      socket.off("receive_song");
      socket.off("receive_action");
      socket.off("update_queue");
    };
  }, []);

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

  // --- HOST CONTROLS ---

  // 1. Play Now (Clears current song and plays new one)
  const loadSong = () => {
    if (!searchQuery) return;
    socket.emit("play_song", { room, videoId: searchQuery });
    setSearchQuery("");
  };

  // 2. Add to Queue
  const addToQueue = () => {
    if (!searchQuery) return;
    socket.emit("add_to_queue", { room, videoId: searchQuery });
    setSearchQuery("");
  };

  // 3. Play Next (Manually or Automatically)
  const playNext = () => {
    if (queue.length > 0) {
      socket.emit("play_next", { room });
    } else {
      console.log("Queue is empty");
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
        // Song ended -> Auto-play next song
        playNext();
      }
    }
  };

  // --- PLAYER CONFIG ---

  const opts = {
    height: "0",
    width: "0",
    playerVars: { 
      autoplay: 1, // Crucial: Auto-plays when loaded
      controls: 0 
    },
  };

  // CRITICAL FIX: onReady handler
  // When a new user joins, their player loads. 
  // If the room is already playing, we must force their player to start.
  const onPlayerReady = (event) => {
    playerRef.current = event.target;
    
    // If the global state says we should be playing, force it now.
    if (isPlaying) {
      event.target.playVideo();
    }
  };

  const togglePlay = () => {
    if (playerRef.current) playerRef.current.playVideo();
  };

  const togglePause = () => {
    if (playerRef.current) playerRef.current.pauseVideo();
  };

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
            {/* Dynamic Album Art */}
            <div className={`album-art ${isPlaying ? "pulse" : ""}`}>
              {isPlaying ? "🔊" : "🎵"}
            </div>
            
            <div className="track-info">
              <h3>{videoId ? "Now Playing" : "No Song Selected"}</h3>
              <p>ID: {videoId}</p>
              
              {/* Status Text */}
              <div className={`status-badge ${isPlaying ? "playing" : "paused"}`}>
                {videoId ? (isPlaying ? "▶ Playing" : "⏸ Paused") : "Waiting for song..."}
              </div>
            </div>
          </div>

          <div className="hidden-player">
            <YouTube
              videoId={videoId}
              opts={opts}
              onReady={onPlayerReady} // Updated handler
              onStateChange={handlePlayerStateChange}
            />
          </div>

          {/* HOST CONTROLS */}
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
              {isPlaying ? "Listen along! 🎧" : "Host has paused the music."}
            </p>
          )}

          {/* QUEUE DISPLAY (Visible to everyone) */}
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