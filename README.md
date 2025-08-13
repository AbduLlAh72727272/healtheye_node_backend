# HealthEye Backend

A Node.js backend for the HealthEye medical chatbot application with AI-powered health insights and report processing.

## Features

- 🤖 AI-powered health chatbot using Google Gemini
- 📄 PDF and image report processing with OCR
- 🧠 Health insights generation
- 💬 Conversation history management
- 📊 Health parameter analysis
- 🔒 Secure API endpoints

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file with your API keys:
```bash
cp env.example .env
# Edit .env with your actual API keys
```

3. Start development server:
```bash
npm run dev
```

## Deployment to Render

### Option 1: Automatic Deployment (Recommended)

1. **Fork/Clone this repository to your GitHub account**

2. **Sign up for Render** at [render.com](https://render.com)

3. **Create a new Web Service**:
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Select the repository with this code

4. **Configure the service**:
   - **Name**: `healtheye-backend`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Health Check Path**: `/health`

5. **Add Environment Variables**:
   - `GEMINI_API_KEY`: Your Google Gemini API key
   - `HUGGING_FACE_API_TOKEN`: Your Hugging Face API token (optional)
   - `NODE_ENV`: `production`

6. **Deploy**: Click "Create Web Service"

### Option 2: Manual Deployment

1. **Install Render CLI**:
```bash
npm install -g @render/cli
```

2. **Login to Render**:
```bash
render login
```

3. **Deploy using render.yaml**:
```bash
render deploy
```

## API Endpoints

- `GET /` - API information
- `GET /health` - Health check
- `POST /chat` - Chat with AI health assistant
- `GET /chat/history/:userId` - Get conversation history
- `DELETE /chat/history/:userId` - Clear conversation history
- `POST /api/upload-report` - Upload and process health reports
- `POST /api/health-insights` - Get health insights for parameters

## Environment Variables

- `GEMINI_API_KEY`: Google Gemini API key (required)
- `HUGGING_FACE_API_TOKEN`: Hugging Face API token (optional)
- `PORT`: Server port (default: 3000)
- `NODE_ENV`: Environment (development/production)

## Flutter Integration

After deployment, update your Flutter app's API base URL to:
```dart
static const String baseUrl = 'https://your-service-name.onrender.com';
```

## Support

For issues or questions, please check the Render logs or create an issue in the repository.
