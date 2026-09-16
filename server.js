const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Map to keep track of active users
const activeUsers = new Map();

// Clean up inactive users every 5 seconds
setInterval(() => {
    const now = Date.now();
    for (const [id, lastPing] of activeUsers.entries()) {
        if (now - lastPing > 20000) { // Timeout after 20 seconds
            activeUsers.delete(id);
        }
    }
}, 5000);

// Endpoint for heartbeat pings from extension
app.post('/ping', (req, res) => {
    const { deviceId } = req.body;
    if (deviceId) {
        activeUsers.set(deviceId, Date.now());
    }
    res.json({ onlineUsers: activeUsers.size });
});

// Root path for health check
app.get('/', (req, res) => {
    res.send('Falcon Counter Server is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
