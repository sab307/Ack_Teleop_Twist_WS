# Ack_Teleop_Twist_WS
Twist messages being sent from browser to operate Robot using Websocket. PING/PONG for synchronization.
```
cd go_relay
go mod tidy
go run .
```

```
cd python-client
pip install -r requirements.txt
python3 main.py --url ws://localhost:8080 --topic /cmd_vel
```