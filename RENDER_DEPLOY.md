# 🚀 HealthEye Node.js Backend - Render Deployment Guide

## 📋 Quick Deploy Steps

### 1. Push Code to GitHub
Make sure your code is pushed to your GitHub repository.

### 2. Connect to Render
1. Go to [render.com](https://render.com) and sign in
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository `healtheye`

### 3. Configure Service
- **Name**: `healtheye-node-backend`
- **Region**: Oregon (US-West)
- **Branch**: `main`
- **Runtime**: Node
- **Build Command**: `npm ci`
- **Start Command**: `npm start`
- **Root Directory**: `backend`

### 4. Set Environment Variables
In Render dashboard, add:
```
NODE_ENV = production
GEMINI_API_KEY = your_actual_api_key_here
```

### 5. Deploy
Click **"Create Web Service"** and wait for deployment.

## 🔗 Your API will be available at:
```
https://healtheye-node-backend.onrender.com
```

## 📝 API Endpoints:
- `GET /health` - Health check
- `GET /` - API info
- `POST /api/chat` - AI chatbot
- `POST /api/upload` - File upload & analysis
- `POST /api/health-insights` - Health insights

## 🛠️ Testing Your Deployment:
```bash
curl https://healtheye-node-backend.onrender.com/health
```

## ⚠️ Important Notes:
- Free tier has cold starts (may be slow on first request)
- Service sleeps after 15 minutes of inactivity
- 750 hours/month free tier limit