const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const activeUsers = new Map();

app.post('/api/heartbeat', (req, res) => {
    const { userId } = req.body;
    if (userId) {
        activeUsers.set(userId, Date.now());
    }
    res.json({ success: true });
});

app.get('/api/online-count', (req, res) => {
    const now = Date.now();
    const timeout = 2 * 60 * 1000;

    for (const [id, lastSeen] of activeUsers.entries()) {
        if (now - lastSeen > timeout) {
            activeUsers.delete(id);
        }
    }

    res.json({ online: activeUsers.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
