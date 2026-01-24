# 🔧 Shared Backend API

**ONE Backend API for 3 Frontend Platforms**

This is the unified backend API that powers:
- 👻 **Ghost OS** - AI voice assistant platform
- 💼 **CyberCheck** - Business management platform
- 🌊 **GCR** - Gulf Coast Radar business directory

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment variables
cp .env.example .env
# Then edit .env with your actual keys

# 3. Run development server
npm run dev

# Server runs on http://localhost:3000
```

---

## 📁 Project Structure

```
backend-api/
├── src/
│   ├── index.js                 ← Main server file
│   ├── config/                  ← Configuration (Supabase, OpenAI, Twilio)
│   ├── middleware/              ← Auth, CORS, error handling
│   ├── services/                ← Business logic (AI, SMS, etc.)
│   └── routes/
│       ├── shared/              ← Shared routes (auth, users, billing)
│       │   ├── auth.js
│       │   ├── users.js
│       │   └── billing.js
│       ├── ghost-os/            ← Ghost OS specific routes
│       │   ├── demo.js
│       │   ├── voice.js
│       │   └── admin.js
│       ├── cybercheck/          ← CyberCheck specific routes
│       │   ├── dashboard.js
│       │   ├── contacts.js
│       │   ├── menu.js
│       │   └── reviews.js
│       └── gcr/                 ← GCR specific routes
│           ├── businesses.js
│           ├── featured.js
│           └── search.js
├── migrations/                  ← Database migrations
├── .env.example                 ← Environment variables template
├── .gitignore
├── package.json
└── README.md
```

---

## 🔌 API Endpoints

### **Health Check**
```
GET  /                → API info
GET  /health          → Health status
```

### **Shared Endpoints (All Platforms)**
```
POST   /api/shared/auth/login
POST   /api/shared/auth/signup
POST   /api/shared/auth/refresh
GET    /api/shared/users/me
PUT    /api/shared/users/profile
GET    /api/shared/billing/subscription
```

### **Ghost OS Endpoints**
```
POST   /api/ghost-os/demo/signup
GET    /api/ghost-os/demo/queue-status
POST   /api/ghost-os/voice/incoming
```

### **CyberCheck Endpoints**
```
GET    /api/cybercheck/dashboard/stats
GET    /api/cybercheck/contacts
POST   /api/cybercheck/contacts
GET    /api/cybercheck/menu/items
PUT    /api/cybercheck/menu/items/:id
```

### **GCR Endpoints**
```
GET    /api/gcr/businesses
GET    /api/gcr/businesses/:slug
GET    /api/gcr/search
```

---

## 🔐 Authentication

All platforms use shared JWT authentication:

```javascript
// Login from any platform
POST /api/shared/auth/login
{
  "email": "user@example.com",
  "password": "password123"
}

// Returns JWT token that works across ALL platforms
{
  "token": "eyJhbGc...",
  "user": { ... }
}

// Use token in requests
Authorization: Bearer eyJhbGc...
```

---

## 🌐 CORS Configuration

The API allows requests from:
- Ghost OS frontend (ghostos.ai)
- CyberCheck frontend (cybercheck.com)
- GCR frontend (gulfcoastradar.com)

Configure URLs in `.env`:
```
GHOST_OS_URL=https://ghostos.ai
CYBERCHECK_URL=https://cybercheck.com
GCR_URL=https://gulfcoastradar.com
```

---

## 📦 Environment Variables

See `.env.example` for all required variables:

**Required:**
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` - Database
- `JWT_SECRET` - Authentication
- `OPENAI_API_KEY` - AI features
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` - SMS/Voice

**Optional:**
- `STRIPE_SECRET_KEY` - Payments
- `REDIS_URL` - Caching
- `SENDGRID_API_KEY` - Emails

---

## 🚀 Deployment

### **Option 1: Railway**
```bash
railway login
railway init
railway up
```

### **Option 2: Render**
```bash
# Connect GitHub repo
# Set environment variables in dashboard
# Deploy automatically
```

### **Option 3: Heroku**
```bash
heroku create your-api-name
git push heroku main
```

---

## 🛠️ Development

```bash
# Start development server (auto-reload)
npm run dev

# Start production server
npm start

# Run tests
npm test
```

---

## 📝 Adding New Routes

### 1. Create route file
```javascript
// src/routes/ghost-os/my-feature.js
import express from 'express';
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'My feature' });
});

export default router;
```

### 2. Import in index.js
```javascript
import myFeatureRoutes from './routes/ghost-os/my-feature.js';
app.use('/api/ghost-os/my-feature', myFeatureRoutes);
```

### 3. Test
```bash
curl http://localhost:3000/api/ghost-os/my-feature
```

---

## 🔧 Troubleshooting

**Port already in use:**
```bash
# Change PORT in .env
PORT=3001
```

**CORS errors:**
```bash
# Add your frontend URL to .env
GHOST_OS_URL=http://localhost:3000
```

**Database connection failed:**
```bash
# Check Supabase credentials in .env
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
```

---

## 📚 Documentation

- [Architecture Overview](../SHARED-BACKEND-ARCHITECTURE.md)
- [API Documentation](./API_DOCUMENTATION.md)
- [Deployment Guide](./DEPLOYMENT.md)

---

## 🤝 Contributing

This is a solo project, but future contributions welcome!

1. Create feature branch
2. Make changes
3. Test thoroughly
4. Submit PR

---

## 📄 License

MIT License - See LICENSE file
