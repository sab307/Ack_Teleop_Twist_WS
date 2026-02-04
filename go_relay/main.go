package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

/*
BINARY PROTOCOL
===============

All messages use little-endian byte order.
First byte is message type:
  0x01 = Twist Command
  0x02 = Twist Ack
  0x03 = Clock Sync Request
  0x04 = Clock Sync Response

MESSAGE SIZES
-------------
  Twist (browser):     65 bytes
  Twist (to python):   81 bytes (+16 for relay timestamps)
  Ack (from python):   69 bytes
  Ack (to browser):    77 bytes (+8 for t5_relay_ack_tx)
  Clock Sync Request:   9 bytes
  Clock Sync Response: 25 bytes
*/

// Message type constants
const (
	MsgTypeTwist            = 0x01
	MsgTypeTwistAck         = 0x02
	MsgTypeClockSyncRequest = 0x03
	MsgTypeClockSyncResp    = 0x04

	TwistBrowserSize  = 65
	TwistToPythonSize = 81
	AckFromPythonSize = 69
	AckToBrowserSize  = 77
	ClockSyncReqSize  = 9
	ClockSyncRespSize = 25
)

// currentTimeMs returns milliseconds since Unix epoch
func currentTimeMs() uint64 {
	return uint64(time.Now().UnixMilli())
}

// Peer represents a WebSocket connection
type Peer struct {
	ID       string
	Type     string // "web" or "python"
	Conn     *websocket.Conn
	SendChan chan []byte
	mu       sync.Mutex
}

// PeerManager manages connected peers
type PeerManager struct {
	mu         sync.RWMutex
	peers      map[string]*Peer
	webPeers   map[string]*Peer
	pythonPeer *Peer
}

var manager = &PeerManager{
	peers:    make(map[string]*Peer),
	webPeers: make(map[string]*Peer),
}

var upgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

func newPeerID() string {
	return fmt.Sprintf("peer_%d", time.Now().UnixNano())
}

func (m *PeerManager) addPeer(p *Peer) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.peers[p.ID] = p
	if p.Type == "web" {
		m.webPeers[p.ID] = p
	} else if p.Type == "python" {
		m.pythonPeer = p
	}
	log.Printf("+ Peer %s (%s), total: %d", p.ID, p.Type, len(m.peers))
}

func (m *PeerManager) removePeer(p *Peer) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.peers, p.ID)
	delete(m.webPeers, p.ID)
	if m.pythonPeer != nil && m.pythonPeer.ID == p.ID {
		m.pythonPeer = nil
	}
	log.Printf("- Peer %s, total: %d", p.ID, len(m.peers))
}

func (m *PeerManager) getPython() *Peer {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.pythonPeer
}

func (m *PeerManager) getWebPeers() []*Peer {
	m.mu.RLock()
	defer m.mu.RUnlock()
	peers := make([]*Peer, 0, len(m.webPeers))
	for _, p := range m.webPeers {
		peers = append(peers, p)
	}
	return peers
}

// WebSocket handler
func handleWS(w http.ResponseWriter, r *http.Request) {
	peerType := r.URL.Query().Get("type")
	if peerType == "" {
		peerType = "web"
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}

	peer := &Peer{
		ID:       newPeerID(),
		Type:     peerType,
		Conn:     conn,
		SendChan: make(chan []byte, 256),
	}
	manager.addPeer(peer)

	defer func() {
		manager.removePeer(peer)
		conn.Close()
	}()

	// Send welcome (JSON)
	welcome := map[string]interface{}{
		"type":    "welcome",
		"peer_id": peer.ID,
	}
	conn.WriteJSON(welcome)

	// Start writer goroutine
	go writeLoop(peer)

	// Read loop
	readLoop(peer)
}

func writeLoop(peer *Peer) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-peer.SendChan:
			if !ok {
				peer.Conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			peer.mu.Lock()
			err := peer.Conn.WriteMessage(websocket.BinaryMessage, msg)
			peer.mu.Unlock()
			if err != nil {
				return
			}

		case <-ticker.C:
			peer.mu.Lock()
			err := peer.Conn.WriteMessage(websocket.PingMessage, nil)
			peer.mu.Unlock()
			if err != nil {
				return
			}
		}
	}
}

func readLoop(peer *Peer) {
	peer.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	peer.Conn.SetPongHandler(func(string) error {
		peer.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		msgType, data, err := peer.Conn.ReadMessage()
		if err != nil {
			return
		}
		peer.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		if msgType == websocket.BinaryMessage {
			handleBinary(peer, data)
		}
	}
}

func handleBinary(peer *Peer, data []byte) {
	if len(data) < 1 {
		return
	}

	switch data[0] {
	case MsgTypeTwist:
		handleTwist(peer, data)
	case MsgTypeTwistAck:
		handleAck(peer, data)
	case MsgTypeClockSyncRequest:
		handleClockSync(peer, data)
	}
}

func handleTwist(peer *Peer, data []byte) {
	t2 := currentTimeMs() // Relay receive time

	if len(data) < TwistBrowserSize {
		log.Printf("Invalid twist size: %d", len(data))
		return
	}

	python := manager.getPython()
	if python == nil {
		log.Printf("No Python peer")
		return
	}

	// Create extended message with relay timestamps
	extended := make([]byte, TwistToPythonSize)
	copy(extended, data[:TwistBrowserSize])

	// Append relay timestamps (t2 and t3)
	t3 := currentTimeMs() // Relay forward time
	binary.LittleEndian.PutUint64(extended[65:], t2)
	binary.LittleEndian.PutUint64(extended[73:], t3)

	// Send to Python
	select {
	case python.SendChan <- extended:
		msgID := binary.LittleEndian.Uint64(data[1:9])
		log.Printf("→ Python: Twist #%d (t2=%d, t3=%d)", msgID, t2, t3)
	default:
		log.Printf("Python send buffer full")
	}
}

func handleAck(peer *Peer, data []byte) {
	t4 := currentTimeMs() // Relay ack receive time

	if peer.Type != "python" {
		return
	}

	if len(data) < AckFromPythonSize {
		log.Printf("Invalid ack size: %d bytes (expected %d)", len(data), AckFromPythonSize)
		return
	}

	// Create extended ack for browser
	extended := make([]byte, AckToBrowserSize)
	copy(extended, data[:AckFromPythonSize])

	// Fill t4_relay_ack_rx at offset 61 and append t5 at offset 69
	t5 := currentTimeMs()
	binary.LittleEndian.PutUint64(extended[61:69], t4)
	binary.LittleEndian.PutUint64(extended[69:77], t5)

	// Forward to all web peers
	webPeers := manager.getWebPeers()
	for _, web := range webPeers {
		select {
		case web.SendChan <- extended:
		default:
		}
	}

	msgID := binary.LittleEndian.Uint64(data[1:9])
	log.Printf("← Browser: Ack #%d to %d peers (t4=%d, t5=%d)", msgID, len(webPeers), t4, t5)
}

func handleClockSync(peer *Peer, data []byte) {
	t2 := currentTimeMs()

	if len(data) < ClockSyncReqSize {
		return
	}

	t1 := binary.LittleEndian.Uint64(data[1:9])
	t3 := currentTimeMs()

	resp := make([]byte, ClockSyncRespSize)
	resp[0] = MsgTypeClockSyncResp
	binary.LittleEndian.PutUint64(resp[1:], t1)
	binary.LittleEndian.PutUint64(resp[9:], t2)
	binary.LittleEndian.PutUint64(resp[17:], t3)

	select {
	case peer.SendChan <- resp:
		log.Printf("Clock sync: t1=%d t2=%d t3=%d", t1, t2, t3)
	default:
	}
}

// HTTP handlers
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "ok",
		"time":   currentTimeMs(),
	})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	manager.mu.RLock()
	defer manager.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"total_peers":      len(manager.peers),
		"web_peers":        len(manager.webPeers),
		"python_connected": manager.pythonPeer != nil,
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == "OPTIONS" {
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/data", handleWS)
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/status", handleStatus)
	mux.Handle("/", http.FileServer(http.Dir("../web-client")))

	fmt.Println(`
╔═══════════════════════════════════════════════════════════╗
║     Teleop Relay - Binary Protocol                        ║
╚═══════════════════════════════════════════════════════════╝`)
	fmt.Println()
	fmt.Println("Binary Message Sizes:")
	fmt.Println("  0x01 Twist:    65B (browser) → 81B (to Python)")
	fmt.Println("  0x02 Ack:      69B (Python)  → 77B (to browser)")
	fmt.Println("  0x03 SyncReq:   9B")
	fmt.Println("  0x04 SyncResp: 25B")
	fmt.Println()
	fmt.Printf("Listening on :%s\n", port)
	fmt.Println("  WS  /ws/data  - Binary data")
	fmt.Println("  GET /         - Web client")

	log.Fatal(http.ListenAndServe(":"+port, corsMiddleware(mux)))
}
