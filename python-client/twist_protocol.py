
import struct
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Optional


# =============================================================================
# CONSTANTS
# =============================================================================

class MessageType(IntEnum):
    """Message type identifiers (first byte of every message)."""
    TWIST = 0x01
    TWIST_ACK = 0x02
    CLOCK_SYNC_REQUEST = 0x03
    CLOCK_SYNC_RESPONSE = 0x04


# Binary format strings for struct.pack/unpack
# '<' = little-endian, 'B' = uint8, 'Q' = uint64, 'd' = float64, 'I' = uint32

TWIST_BROWSER_FORMAT = '<BQQ6d'      # type + msg_id + t1 + 6 velocities = 65 bytes
TWIST_BROWSER_SIZE = 65

TWIST_RELAY_FORMAT = '<BQQ6d2Q'      # Above + t2_relay_rx + t3_relay_tx = 81 bytes
TWIST_RELAY_SIZE = 81

TWIST_ACK_PYTHON_FORMAT = '<BQ5Q3IQ'  # type + msg_id + 5 timestamps + 3 durations + reserved = 69 bytes
TWIST_ACK_PYTHON_SIZE = 69  # 1 + 8 + 40 + 12 + 8 = 69

TWIST_ACK_BROWSER_FORMAT = '<BQ6Q3IQQ'  # Above + t5_relay_ack_tx = 77 bytes
TWIST_ACK_BROWSER_SIZE = 77

CLOCK_SYNC_REQUEST_FORMAT = '<BQ'    # type + t1 = 9 bytes
CLOCK_SYNC_REQUEST_SIZE = 9

CLOCK_SYNC_RESPONSE_FORMAT = '<BQQQ'  # type + t1 + t2 + t3 = 25 bytes
CLOCK_SYNC_RESPONSE_SIZE = 25


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def current_time_ms() -> int:
    """Current time in milliseconds since Unix epoch."""
    return int(time.time() * 1000)


def perf_counter_us() -> int:
    """High-precision counter in microseconds (for measuring durations)."""
    return int(time.perf_counter() * 1_000_000)


# =============================================================================
# DATA CLASSES
# =============================================================================

@dataclass
class LatencyTimestamps:
    
    # Browser timestamps (ms)
    t1_browser_send: int = 0
    
    # Relay timestamps (ms)
    t2_relay_rx: int = 0
    t3_relay_tx: int = 0
    t4_relay_ack_rx: int = 0
    t5_relay_ack_tx: int = 0
    
    # Python timestamps and durations
    t3_python_rx: int = 0           # ms
    t4_python_ack: int = 0          # ms
    python_decode_us: int = 0       # μs
    python_process_us: int = 0      # μs
    python_encode_us: int = 0       # μs


@dataclass
class TwistWithLatency:
    
    # Twist velocities (same as ROS geometry_msgs/Twist)
    linear_x: float = 0.0
    linear_y: float = 0.0
    linear_z: float = 0.0
    angular_x: float = 0.0
    angular_y: float = 0.0
    angular_z: float = 0.0
    
    # Tracking
    message_id: int = 0
    timestamps: LatencyTimestamps = field(default_factory=LatencyTimestamps)
    
    def encode(self) -> bytes:
        """Encode to binary format (65 bytes).
        
        STEP BY STEP:
        1. struct.pack('<BQQ6d', ...) creates a bytes object
        2. '<' specifies little-endian byte order
        3. 'B' packs message type as 1 byte (uint8)
        4. 'Q' packs message_id as 8 bytes (uint64)
        5. 'Q' packs timestamp as 8 bytes (uint64)
        6. '6d' packs 6 floats as 48 bytes (6 × float64)
        
        Total: 1 + 8 + 8 + 48 = 65 bytes
        """
        return struct.pack(
            TWIST_BROWSER_FORMAT,
            MessageType.TWIST,               # B: 1 byte - message type
            self.message_id,                 # Q: 8 bytes - message ID
            self.timestamps.t1_browser_send, # Q: 8 bytes - browser send time
            self.linear_x,                   # d: 8 bytes - linear velocity X
            self.linear_y,                   # d: 8 bytes - linear velocity Y
            self.linear_z,                   # d: 8 bytes - linear velocity Z
            self.angular_x,                  # d: 8 bytes - angular velocity X
            self.angular_y,                  # d: 8 bytes - angular velocity Y
            self.angular_z,                  # d: 8 bytes - angular velocity Z
        )
    
    @classmethod
    def decode(cls, data: bytes) -> 'TwistWithLatency':
        """Decode from binary format (65 or 81 bytes).
        
        STEP BY STEP:
        1. Check data length (65 from browser, 81 from relay)
        2. Verify first byte is 0x01 (TWIST message type)
        3. struct.unpack() reads bytes in same order as pack()
        4. Returns tuple: (type, msg_id, t1, lin_x, lin_y, lin_z, ang_x, ang_y, ang_z, [t2, t3])
        
        """
        if len(data) < TWIST_BROWSER_SIZE:
            raise ValueError(f"Expected at least {TWIST_BROWSER_SIZE} bytes, got {len(data)}")
        
        # Verify message type
        if data[0] != MessageType.TWIST:
            raise ValueError(f"Expected TWIST (0x01), got 0x{data[0]:02x}")
        
        # Check if we have relay timestamps (81 bytes)
        if len(data) >= TWIST_RELAY_SIZE:
            values = struct.unpack(TWIST_RELAY_FORMAT, data[:TWIST_RELAY_SIZE])
            # values = (type, msg_id, t1, lin_x, lin_y, lin_z, ang_x, ang_y, ang_z, t2, t3)
            return cls(
                message_id=values[1],
                timestamps=LatencyTimestamps(
                    t1_browser_send=values[2],
                    t2_relay_rx=values[9],
                    t3_relay_tx=values[10]
                ),
                linear_x=values[3],
                linear_y=values[4],
                linear_z=values[5],
                angular_x=values[6],
                angular_y=values[7],
                angular_z=values[8]
            )
        else:
            # Browser format (65 bytes) - no relay timestamps
            values = struct.unpack(TWIST_BROWSER_FORMAT, data[:TWIST_BROWSER_SIZE])
            return cls(
                message_id=values[1],
                timestamps=LatencyTimestamps(t1_browser_send=values[2]),
                linear_x=values[3],
                linear_y=values[4],
                linear_z=values[5],
                angular_x=values[6],
                angular_y=values[7],
                angular_z=values[8]
            )
    
    def __str__(self) -> str:
        return (f"Twist#{self.message_id}[lin:({self.linear_x:.2f},{self.linear_y:.2f},{self.linear_z:.2f}) "
                f"ang:({self.angular_x:.2f},{self.angular_y:.2f},{self.angular_z:.2f})]")


@dataclass
class TwistAck:
    
    message_id: int
    timestamps: LatencyTimestamps
    
    def encode(self) -> bytes:
        """Encode to binary (69 bytes).
        
        Format: '<BQ6Q3IQ'
        - B: message type (1 byte)
        - Q: message_id (8 bytes)
        - 6Q: 6 timestamps (48 bytes)
        - 3I: 3 durations in μs (12 bytes)
        - Q: reserved for relay (8 bytes)
        """
        ts = self.timestamps
        return struct.pack(
            TWIST_ACK_PYTHON_FORMAT,
            MessageType.TWIST_ACK,     # B: message type
            self.message_id,           # Q: message ID
            ts.t1_browser_send,        # Q: browser send time
            ts.t2_relay_rx,            # Q: relay receive time
            ts.t3_relay_tx,            # Q: relay forward time
            ts.t3_python_rx,           # Q: python receive time
            ts.t4_python_ack,          # Q: python ack time
            ts.python_decode_us,       # I: decode duration (μs)
            ts.python_process_us,      # I: process duration (μs)
            ts.python_encode_us,       # I: encode duration (μs)
            0,                         # Q: reserved for t4_relay_ack_rx
        )
    
    @classmethod
    def decode(cls, data: bytes) -> 'TwistAck':
        """Decode from binary (69 or 77 bytes)."""
        if len(data) < TWIST_ACK_PYTHON_SIZE:
            raise ValueError(f"Expected at least {TWIST_ACK_PYTHON_SIZE} bytes, got {len(data)}")
        
        if data[0] != MessageType.TWIST_ACK:
            raise ValueError(f"Expected TWIST_ACK (0x02), got 0x{data[0]:02x}")
        
        values = struct.unpack(TWIST_ACK_PYTHON_FORMAT, data[:TWIST_ACK_PYTHON_SIZE])
        
        timestamps = LatencyTimestamps(
            t1_browser_send=values[1],
            t2_relay_rx=values[2],
            t3_relay_tx=values[3],
            t3_python_rx=values[4],
            t4_python_ack=values[5],
            python_decode_us=values[6],
            python_process_us=values[7],
            python_encode_us=values[8],
            t4_relay_ack_rx=values[9],
        )
        
        # Check for relay-appended timestamp
        if len(data) >= TWIST_ACK_BROWSER_SIZE:
            t5 = struct.unpack('<Q', data[TWIST_ACK_PYTHON_SIZE:TWIST_ACK_BROWSER_SIZE])[0]
            timestamps.t5_relay_ack_tx = t5
        
        return cls(message_id=values[1], timestamps=timestamps)


@dataclass
class ClockSyncRequest:
    """Clock sync request (9 bytes)."""
    t1: int  # Client send time in ms
    
    def encode(self) -> bytes:
        """Encode: type (1 byte) + t1 (8 bytes)."""
        return struct.pack(CLOCK_SYNC_REQUEST_FORMAT, MessageType.CLOCK_SYNC_REQUEST, self.t1)
    
    @classmethod
    def decode(cls, data: bytes) -> 'ClockSyncRequest':
        if len(data) < CLOCK_SYNC_REQUEST_SIZE:
            raise ValueError(f"Expected {CLOCK_SYNC_REQUEST_SIZE} bytes")
        values = struct.unpack(CLOCK_SYNC_REQUEST_FORMAT, data[:CLOCK_SYNC_REQUEST_SIZE])
        return cls(t1=values[1])


@dataclass
class ClockSyncResponse:
    """Clock sync response (25 bytes).
    
    NTP-style offset calculation:
        RTT = (t4 - t1) - (t3 - t2)
        Offset = ((t2 - t1) + (t3 - t4)) / 2
    """
    t1: int  # Original client send time
    t2: int  # Server receive time
    t3: int  # Server send time
    
    def encode(self) -> bytes:
        return struct.pack(CLOCK_SYNC_RESPONSE_FORMAT, MessageType.CLOCK_SYNC_RESPONSE, self.t1, self.t2, self.t3)
    
    @classmethod
    def decode(cls, data: bytes) -> 'ClockSyncResponse':
        if len(data) < CLOCK_SYNC_RESPONSE_SIZE:
            raise ValueError(f"Expected {CLOCK_SYNC_RESPONSE_SIZE} bytes")
        values = struct.unpack(CLOCK_SYNC_RESPONSE_FORMAT, data[:CLOCK_SYNC_RESPONSE_SIZE])
        return cls(t1=values[1], t2=values[2], t3=values[3])


# =============================================================================
# SELF-TEST
# =============================================================================

if __name__ == "__main__":
    print("=" * 70)
    print("BINARY PROTOCOL TEST")
    print("=" * 70)
    
    # Test TwistWithLatency
    print("\n1. TwistWithLatency Encoding/Decoding")
    print("-" * 50)
    
    twist = TwistWithLatency(
        message_id=12345,
        linear_y=1.5,
        angular_z=-0.75,
        timestamps=LatencyTimestamps(t1_browser_send=current_time_ms())
    )
    
    encoded = twist.encode()
    print(f"   Original: {twist}")
    print(f"   Encoded size: {len(encoded)} bytes (expected: 65)")
    print(f"   First 20 bytes (hex): {encoded[:20].hex()}")
    print(f"   Message type byte: 0x{encoded[0]:02x}")
    
    decoded = TwistWithLatency.decode(encoded)
    print(f"   Decoded: {decoded}")
    print(f"   Values match: {decoded.message_id == twist.message_id and decoded.linear_y == twist.linear_y}")
    
    # Test with relay timestamps
    print("\n2. TwistWithLatency with Relay Timestamps")
    print("-" * 50)
    
    relay_data = encoded + struct.pack('<QQ', 1000, 1001)  # Add t2, t3
    decoded_relay = TwistWithLatency.decode(relay_data)
    print(f"   With relay times ({len(relay_data)} bytes):")
    print(f"   t2_relay_rx: {decoded_relay.timestamps.t2_relay_rx}")
    print(f"   t3_relay_tx: {decoded_relay.timestamps.t3_relay_tx}")
    
    # Test TwistAck
    print("\n3. TwistAck Encoding/Decoding")
    print("-" * 50)
    
    ack = TwistAck(
        message_id=12345,
        timestamps=LatencyTimestamps(
            t1_browser_send=1000,
            t2_relay_rx=1005,
            t3_relay_tx=1006,
            t3_python_rx=1010,
            t4_python_ack=1015,
            python_decode_us=50,
            python_process_us=100,
            python_encode_us=30
        )
    )
    
    ack_encoded = ack.encode()
    print(f"   Encoded size: {len(ack_encoded)} bytes (expected: 69)")
    print(f"   Message type byte: 0x{ack_encoded[0]:02x}")
    
    # Test ClockSync
    print("\n4. ClockSync Encoding/Decoding")
    print("-" * 50)
    
    req = ClockSyncRequest(t1=current_time_ms())
    req_encoded = req.encode()
    print(f"   Request size: {len(req_encoded)} bytes (expected: 9)")
    
    resp = ClockSyncResponse(t1=1000, t2=1005, t3=1006)
    resp_encoded = resp.encode()
    print(f"   Response size: {len(resp_encoded)} bytes (expected: 25)")
    
    # Performance test
    print("\n5. Performance Test (100,000 iterations)")
    print("-" * 50)
    
    import time as t
    iterations = 100000
    
    start = t.perf_counter_ns()
    for _ in range(iterations):
        data = twist.encode()
    encode_time = (t.perf_counter_ns() - start) / iterations
    
    start = t.perf_counter_ns()
    for _ in range(iterations):
        TwistWithLatency.decode(data)
    decode_time = (t.perf_counter_ns() - start) / iterations
    
    print(f"   Encode: {encode_time/1000:.2f} μs/msg ({1_000_000_000/encode_time:,.0f} msg/s)")
    print(f"   Decode: {decode_time/1000:.2f} μs/msg ({1_000_000_000/decode_time:,.0f} msg/s)")
    
    print("\n" + "=" * 70)
    print("All tests passed!")
    print("=" * 70)