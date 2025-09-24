const dotenv = require('dotenv');
dotenv.config();

console.log("🔑 GEMINI_API_KEY =", process.env.GEMINI_API_KEY);


const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure we're using the correct port for Render
console.log(`🚀 Starting server on port ${PORT}`);
console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Store conversation history (in a real app, use a database)
let conversationHistory = [];

// Configure multer for file uploads
// Detect Vercel environment
const IS_VERCEL = !!process.env.VERCEL;

// Storage strategy: use disk locally, memory on Vercel (read-only fs except /tmp)
let upload;
if (IS_VERCEL) {
    upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: function (req, file, cb) {
            if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
                cb(null, true);
            } else {
                cb(new Error('Only image files and PDFs are allowed!'), false);
            }
        }
    });
    console.log('📦 Using memory storage for uploads (Vercel environment)');
} else {
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            const uploadDir = 'uploads';
            if (!fs.existsSync(uploadDir)){
                fs.mkdirSync(uploadDir);
            }
            cb(null, uploadDir);
        },
        filename: function (req, file, cb) {
            cb(null, Date.now() + '-' + file.originalname);
        }
    });
    upload = multer({
        storage,
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: function (req, file, cb) {
            if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
                cb(null, true);
            } else {
                cb(new Error('Only image files and PDFs are allowed!'), false);
            }
        }
    });
    console.log('📦 Using disk storage for uploads (non-Vercel environment)');
}

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: '🏥 HealthEye Chatbot API',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            health: 'GET /health',
            chat: 'POST /chat',
            history: 'GET /chat/history/:userId',
            clearHistory: 'DELETE /chat/history/:userId'
        },
        timestamp: new Date().toISOString()
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'HealthEye Chatbot Server is running',
        timestamp: new Date().toISOString()
    });
});

// Chatbot endpoint
app.post('/chat', async (req, res) => {
    try {
        const { message, userId = 'anonymous' } = req.body;
        
        if (!message || message.trim() === '') {
            return res.status(400).json({
                error: 'Message is required',
                success: false
            });
        }

        // Add user message to history
        conversationHistory.push({
            userId,
            message: message.trim(),
            timestamp: new Date().toISOString(),
            sender: 'user'
        });

        // Generate bot response based on message content
        const botResponse = await generateAIResponse(message.trim());
        
        // Add bot response to history
        conversationHistory.push({
            userId,
            message: botResponse,
            timestamp: new Date().toISOString(),
            sender: 'bot'
        });

        res.json({
            success: true,
            response: botResponse,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error in /chat endpoint:', error);
        res.status(500).json({
            error: 'Internal server error',
            success: false,
            response: 'Sorry, I encountered an error. Please try again.'
        });
    }
});

// Get conversation history
app.get('/chat/history/:userId', (req, res) => {
    const { userId } = req.params;
    const userHistory = conversationHistory.filter(msg => msg.userId === userId);
    
    res.json({
        success: true,
        history: userHistory,
        count: userHistory.length
    });
});

// Clear conversation history
app.delete('/chat/history/:userId', (req, res) => {
    const { userId } = req.params;
    conversationHistory = conversationHistory.filter(msg => msg.userId !== userId);
    
    res.json({
        success: true,
        message: 'Conversation history cleared'
    });
});

// Report upload and processing endpoint
app.post('/api/upload-report', upload.single('report'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No file uploaded'
            });
        }

    console.log('📄 Processing uploaded file:', req.file.originalname || req.file.filename);
        
        // Extract text from the uploaded file
    const extractedText = await extractTextFromFile(req.file);
        
        if (!extractedText || extractedText.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Could not extract text from the uploaded file'
            });
        }

        console.log('📋 Extracted text length:', extractedText.length);
        
        // Process the extracted text with AI to get health data
        const healthData = await processHealthReport(extractedText);
        
        // Clean up uploaded file
        if (!IS_VERCEL && req.file && req.file.path) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
        }
        
        res.json({
            success: true,
            data: healthData,
            message: 'Report processed successfully',
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error processing report:', error);
        
        // Clean up file if it exists
        if (!IS_VERCEL && req.file && req.file.path && fs.existsSync(req.file.path)) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
        }
        
        res.status(500).json({
            success: false,
            error: 'Failed to process report',
            message: error.message
        });
    }
});

// Get health insights for a specific parameter
app.post('/api/health-insights', async (req, res) => {
    try {
        const { parameter, value, status } = req.body;
        
        if (!parameter) {
            return res.status(400).json({
                success: false,
                error: 'Parameter is required'
            });
        }
        
        const insights = await generateHealthInsights(parameter, value, status);
        
        res.json({
            success: true,
            insights: insights,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error generating health insights:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate insights'
        });
    }
});

// AI-powered response generator with multiple fallbacks
async function generateAIResponse(message) {
    console.log(`Received message: ${message}`);
    
    // First try free AI APIs
    try {
        // Try free APIs in order of preference
        const freeAIResponse = await tryFreeAIApis(message);
        if (freeAIResponse && freeAIResponse.length > 10) {
            console.log('Got response from free AI API');
            return `🏥 ${freeAIResponse}\n\n⚠️ **Important**: This is general information only. Always consult with a healthcare professional for proper diagnosis and treatment.`;
        }
    } catch (error) {
        console.log('Free AI APIs not available, using rule-based system');
    }
    
    // Fallback to enhanced rule-based responses
    const ruleBasedResponse = generateRuleBasedResponse(message.toLowerCase());
    console.log('Using rule-based response');
    return ruleBasedResponse;
}

// Try multiple free AI APIs
async function tryFreeAIApis(message) {
    // Try Google Gemini first (free tier available)
    try {
        const geminiResponse = await getGeminiResponse(message);
        if (geminiResponse && geminiResponse.length > 10) {
            return geminiResponse;
        }
    } catch (error) {
        console.log('Gemini API not available:', error.message);
    }
    
    // Try other free APIs here in the future
    return null;
}

// Google Gemini AI API call
async function getGeminiResponse(message) {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        console.log('Gemini API key not provided');
        return null;
    }
    
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "models/gemini-1.5-flash-latest" 
          });

        
        const healthPrompt = `You are Dr. Veda, a helpful AI health assistant for a medical app called HealthEye. 
        Provide accurate, helpful medical information while always emphasizing that you cannot replace professional medical advice.
        Keep responses concise (2-3 sentences) and helpful.
        
        User question: "${message}"
        
        Please provide a brief, informative response.`;
        
        const result = await model.generateContent(healthPrompt);
        const response = await result.response;
        return response.text().trim();
    } catch (error) {
        console.log('Gemini API error:', error.message);
        return null;
    }
}

// Hugging Face API call
async function getHuggingFaceResponse(prompt) {
    const huggingFaceApiToken = process.env.HUGGING_FACE_API_TOKEN;
    
    try {
        const response = await axios.post(
            'https://api-inference.huggingface.co/models/microsoft/DialoGPT-medium',
            {
                inputs: prompt,
                parameters: {
                    max_length: 150,
                    temperature: 0.7,
                    top_p: 0.9,
                    return_full_text: false
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${huggingFaceApiToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );
        
        if (response.data && response.data[0] && response.data[0].generated_text) {
            return response.data[0].generated_text.trim();
        }
        return null;
    } catch (error) {
        console.error('Hugging Face API error:', error.message);
        return null;
    }
}

// Extract text from uploaded file (PDF or Image)
async function extractTextFromFile(file) {
    try {
        if (file.mimetype === 'application/pdf') {
            // Extract text from PDF
            const dataBuffer = file.buffer || fs.readFileSync(file.path);
            const data = await pdfParse(dataBuffer);
            return data.text;
        } else if (file.mimetype.startsWith('image/')) {
            // Extract text from image using OCR
            let imageSource = file.path;
            if (file.buffer) {
                // Write buffer temporarily if needed (Vercel memory)
                const tmpPath = path.join('/tmp', `upload-${Date.now()}.img`);
                fs.writeFileSync(tmpPath, file.buffer);
                imageSource = tmpPath;
            }
            const { data: { text } } = await Tesseract.recognize(imageSource, 'eng', {
                logger: m => console.log(m)
            });
            if (file.buffer) {
                try { fs.unlinkSync(imageSource); } catch (_) {}
            }
            return text;
        }
        return null;
    } catch (error) {
        console.error('Error extracting text from file:', error);
        throw error;
    }
}

// Process health report text with AI to extract medical data
async function processHealthReport(text) {
    try {
        console.log('🧪 Processing health report with AI...');
        
        // Try AI-powered analysis first
        const aiAnalysis = await analyzeReportWithAI(text);
        if (aiAnalysis) {
            return aiAnalysis;
        }
        
        // Fallback to pattern-based extraction
        console.log('🔍 Using pattern-based extraction as fallback');
        return extractHealthDataWithPatterns(text);
        
    } catch (error) {
        console.error('Error processing health report:', error);
        // Return fallback data structure
        return {
            healthScore: 75,
            parameters: [
                {
                    name: "General Health",
                    value: "Report processed",
                    status: "Normal",
                    unit: ""
                }
            ],
            summary: "Report uploaded successfully. Please consult with a healthcare professional for detailed analysis."
        };
    }
}

// AI-powered report analysis using Gemini
async function analyzeReportWithAI(text) {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        console.log('Gemini API key not provided for report analysis');
        return null;
    }
    
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "models/gemini-1.5-flash-latest"
        });
        
        const analysisPrompt = `You are a medical AI assistant analyzing a health report. Extract key health parameters and provide a health score.

Medical Report Text:
${text}

Please analyze this medical report and return ONLY a valid JSON object with this exact structure:
{
  "healthScore": number (0-100),
  "parameters": [
    {
      "name": "parameter name",
      "value": "measured value with unit",
      "status": "Normal|Critical|Moderate|Low",
      "unit": "measurement unit"
    }
  ],
  "summary": "brief analysis summary"
}

Look for common health parameters like:
- Blood pressure, cholesterol, glucose, hemoglobin
- Kidney function (creatinine, BUN)
- Liver function (ALT, AST)
- Thyroid function (TSH, T3, T4)
- Vitamins (D, B12, etc.)
- Complete blood count parameters

Assign appropriate status based on normal ranges. Calculate an overall health score based on the findings.`;
        
        const result = await model.generateContent(analysisPrompt);
        const response = await result.response.text();
        
        // Try to extract JSON from the response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const jsonStr = jsonMatch[0];
            return JSON.parse(jsonStr);
        }
        
        console.log('Could not extract valid JSON from AI response');
        return null;
        
    } catch (error) {
        console.log('Error in AI report analysis:', error.message);
        return null;
    }
}

// Pattern-based extraction as fallback
function extractHealthDataWithPatterns(text) {
    const parameters = [];
    let healthScore = 75; // Default score
    
    // Common medical test patterns
    const patterns = {
        // Blood pressure
        bloodPressure: /(?:blood\s*pressure|bp)[:\s]*(\d{2,3})[/\s]*(\d{2,3})/i,
        // Cholesterol
        cholesterol: /(?:cholesterol|chol)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        totalCholesterol: /(?:total\s*cholesterol)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        // Glucose/Sugar
        glucose: /(?:glucose|sugar|fbs|rbs)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        // Hemoglobin
        hemoglobin: /(?:hemoglobin|hb|hgb)[:\s]*(\d+(?:\.\d+)?)\s*(?:g\/dl|g\/l)?/i,
        // Creatinine
        creatinine: /(?:creatinine|creat)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|µmol\/l)?/i,
        // TSH
        tsh: /(?:tsh)[:\s]*(\d+(?:\.\d+)?)\s*(?:µiu\/ml|miu\/l)?/i,
        // Vitamin D
        vitaminD: /(?:vitamin\s*d|25\s*oh\s*d)[:\s]*(\d+(?:\.\d+)?)\s*(?:ng\/ml|nmol\/l)?/i,
        // Vitamin B12
        vitaminB12: /(?:vitamin\s*b12|b12)[:\s]*(\d+(?:\.\d+)?)\s*(?:pg\/ml|pmol\/l)?/i,
    };
    
    // Extract blood pressure
    const bpMatch = text.match(patterns.bloodPressure);
    if (bpMatch) {
        const systolic = parseInt(bpMatch[1]);
        const diastolic = parseInt(bpMatch[2]);
        let status = 'Normal';
        
        if (systolic >= 140 || diastolic >= 90) status = 'Critical';
        else if (systolic >= 130 || diastolic >= 80) status = 'Moderate';
        
        parameters.push({
            name: 'Blood Pressure',
            value: `${systolic}/${diastolic} mmHg`,
            status: status,
            unit: 'mmHg'
        });
        
        if (status === 'Critical') healthScore -= 15;
        else if (status === 'Moderate') healthScore -= 8;
    }
    
    // Extract cholesterol
    const cholMatch = text.match(patterns.totalCholesterol) || text.match(patterns.cholesterol);
    if (cholMatch) {
        const value = parseFloat(cholMatch[1]);
        let status = 'Normal';
        
        if (value >= 240) status = 'Critical';
        else if (value >= 200) status = 'Moderate';
        
        parameters.push({
            name: 'Cholesterol',
            value: `${value} mg/dL`,
            status: status,
            unit: 'mg/dL'
        });
        
        if (status === 'Critical') healthScore -= 10;
        else if (status === 'Moderate') healthScore -= 5;
    }
    
    // Extract glucose
    const glucoseMatch = text.match(patterns.glucose);
    if (glucoseMatch) {
        const value = parseFloat(glucoseMatch[1]);
        let status = 'Normal';
        
        if (value >= 126) status = 'Critical';
        else if (value >= 100) status = 'Moderate';
        else if (value < 70) status = 'Low';
        
        parameters.push({
            name: 'Glucose',
            value: `${value} mg/dL`,
            status: status,
            unit: 'mg/dL'
        });
        
        if (status === 'Critical') healthScore -= 15;
        else if (status === 'Moderate') healthScore -= 8;
        else if (status === 'Low') healthScore -= 10;
    }
    
    // Extract hemoglobin
    const hbMatch = text.match(patterns.hemoglobin);
    if (hbMatch) {
        const value = parseFloat(hbMatch[1]);
        let status = 'Normal';
        
        if (value < 12) status = 'Low';
        else if (value > 16) status = 'Moderate';
        
        parameters.push({
            name: 'Hemoglobin',
            value: `${value} g/dL`,
            status: status,
            unit: 'g/dL'
        });
        
        if (status === 'Low') healthScore -= 10;
    }
    
    // Extract TSH
    const tshMatch = text.match(patterns.tsh);
    if (tshMatch) {
        const value = parseFloat(tshMatch[1]);
        let status = 'Normal';
        
        if (value < 0.4 || value > 4.0) status = 'Moderate';
        
        parameters.push({
            name: 'Thyroid Function (TSH)',
            value: `${value} µIU/mL`,
            status: status,
            unit: 'µIU/mL'
        });
        
        if (status === 'Moderate') healthScore -= 8;
    }
    
    // Extract Vitamin D
    const vitDMatch = text.match(patterns.vitaminD);
    if (vitDMatch) {
        const value = parseFloat(vitDMatch[1]);
        let status = 'Normal';
        
        if (value < 20) status = 'Critical';
        else if (value < 30) status = 'Low';
        
        parameters.push({
            name: 'Vitamin D',
            value: `${value} ng/mL`,
            status: status,
            unit: 'ng/mL'
        });
        
        if (status === 'Critical') healthScore -= 12;
        else if (status === 'Low') healthScore -= 6;
    }
    
    // Extract Vitamin B12
    const vitB12Match = text.match(patterns.vitaminB12);
    if (vitB12Match) {
        const value = parseFloat(vitB12Match[1]);
        let status = 'Normal';
        
        if (value < 200) status = 'Critical';
        else if (value < 300) status = 'Low';
        
        parameters.push({
            name: 'Vitamin B12',
            value: `${value} pg/mL`,
            status: status,
            unit: 'pg/mL'
        });
        
        if (status === 'Critical') healthScore -= 12;
        else if (status === 'Low') healthScore -= 6;
    }
    
    // If no parameters found, add a generic one
    if (parameters.length === 0) {
        parameters.push({
            name: 'General Health Assessment',
            value: 'Report Processed',
            status: 'Normal',
            unit: ''
        });
    }
    
    // Ensure health score is within bounds
    healthScore = Math.max(0, Math.min(100, healthScore));
    
    return {
        healthScore: Math.round(healthScore),
        parameters: parameters,
        summary: `Health report analysis complete. Found ${parameters.length} health parameter(s). Overall health score: ${Math.round(healthScore)}/100.`
    };
}

// Generate health insights for specific parameters
async function generateHealthInsights(parameter, value, status) {
    try {
        // Try AI-powered insights first
        const aiInsights = await getAIHealthInsights(parameter, value, status);
        if (aiInsights) {
            return aiInsights;
        }
        
        // Fallback to predefined insights
        return getStaticHealthInsights(parameter, status);
        
    } catch (error) {
        console.error('Error generating health insights:', error);
        return getStaticHealthInsights(parameter, status);
    }
}

// AI-powered health insights
async function getAIHealthInsights(parameter, value, status) {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        return null;
    }
    
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "models/gemini-1.5-flash-latest"
        });
        
        const insightPrompt = `As a medical AI assistant, provide health insights for:
Parameter: ${parameter}
Value: ${value}
Status: ${status}

Provide a JSON object with these sections:
{
  "impact": "Brief explanation of how this affects overall health",
  "recommendations": "Practical advice for improvement",
  "dietPlan": "Specific dietary recommendations",
  "consultation": "When to seek medical consultation"
}

Keep each section concise (1-2 sentences) and actionable.`;
        
        const result = await model.generateContent(insightPrompt);
        const response = await result.response.text();
        
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        
        return null;
        
    } catch (error) {
        console.log('Error generating AI insights:', error.message);
        return null;
    }
}

// Static health insights as fallback
function getStaticHealthInsights(parameter, status) {
    const insights = {
        impact: `Your ${parameter} levels are currently ${status.toLowerCase()}. This can affect your overall health and well-being.`,
        recommendations: status === 'Critical' ? 
            'Immediate lifestyle changes and medical attention are recommended.' :
            status === 'Moderate' ? 
            'Consider lifestyle modifications and monitor regularly.' :
            'Maintain current healthy practices and regular check-ups.',
        dietPlan: 'Follow a balanced diet rich in fruits, vegetables, whole grains, and lean proteins. Stay hydrated and limit processed foods.',
        consultation: status === 'Critical' ? 
            'Consult a healthcare professional immediately for proper evaluation and treatment.' :
            'Schedule a routine check-up with your healthcare provider to discuss these results.'
    };
    
    return insights;
}

// Enhanced fallback rule-based response generator
function generateRuleBasedResponse(message) {
    // Medical keywords and responses
    const medicalResponses = {
        // Symptoms
        'headache': 'Headaches can be caused by various factors including stress, dehydration, lack of sleep, or underlying conditions. If headaches persist or are severe, please consult a healthcare professional.',
        'fever': 'Fever is often a sign that your body is fighting an infection. Stay hydrated, rest, and monitor your temperature. Seek medical attention if fever is high (>101.3°F) or persists.',
        'cough': 'Coughs can be due to allergies, infections, or other respiratory conditions. Stay hydrated and consider seeing a doctor if the cough persists for more than a few days.',
        'stomach': 'Stomach issues can range from indigestion to more serious conditions. Try bland foods, stay hydrated, and consult a doctor if symptoms persist or worsen.',
        'chest pain': 'Chest pain should be taken seriously. If you\'re experiencing severe chest pain, difficulty breathing, or pain radiating to your arm or jaw, seek emergency medical attention immediately.',
        'shortness of breath': 'Difficulty breathing can indicate various conditions. If you\'re experiencing severe shortness of breath, seek immediate medical attention.',
        'nausea': 'Nausea can be due to various causes. Rest, stay hydrated, and consult a healthcare professional if it persists or worsens.',
        'dizziness': 'Dizziness can result from dehydration, low blood pressure, or other conditions. Sit down and drink water. Seek medical advice if it continues.',
        
        // General health
        'diet': 'A balanced diet including fruits, vegetables, whole grains, and lean proteins is essential for good health. Consider consulting a nutritionist for personalized advice.',
        'exercise': 'Regular physical activity is important for maintaining good health. Aim for at least 150 minutes of moderate exercise per week, but consult your doctor before starting any new exercise program.',
        'sleep': 'Good sleep hygiene is crucial for health. Adults typically need 7-9 hours of sleep per night. Maintain a consistent sleep schedule and create a relaxing bedtime routine.',
        'stress': 'Managing stress is important for both mental and physical health. Consider relaxation techniques, exercise, or speaking with a mental health professional.',
        'hydration': 'Staying hydrated is vital for bodily functions. Drink enough water daily, especially in hot weather or when exercising.',
        'mental health': 'Mental health is as crucial as physical health. Reach out to professionals if you have concerns about mental well-being.',
        
        // Emergency situations
        'emergency': 'If you\'re experiencing a medical emergency, please call emergency services immediately (911 in the US) or go to the nearest emergency room.',
        'suicide': 'If you\'re having thoughts of self-harm, please reach out for help immediately. Contact a crisis helpline, go to an emergency room, or call emergency services.',
        
        // General greetings
        'hello': 'Hello! I\'m Dr. Veda, your AI health assistant. How can I help you with your health concerns today?',
        'hi': 'Hi there! I\'m here to provide general health information. What would you like to know about?',
        'help': 'I can provide general health information about symptoms, wellness tips, and when to seek medical care. Please remember that I cannot replace professional medical advice.',
        'thank you': 'You are welcome! I\'m here to help with any health-related questions or concerns you may have.',
    };

    // Check for specific keywords
    for (const [keyword, response] of Object.entries(medicalResponses)) {
        if (message.includes(keyword)) {
            return `🏥 ${response}\n\n⚠️ **Important**: This is general information only. Always consult with a healthcare professional for proper diagnosis and treatment.`;
        }
    }

    // Check for question patterns
    if (message.includes('what is') || message.includes('what are')) {
        return '🤔 I can provide general health information. Could you be more specific about what health topic you\'d like to know about? For example, symptoms, conditions, or wellness tips.';
    }

    if (message.includes('how to') || message.includes('how can')) {
        return '💡 I\'d be happy to provide general health guidance. Please specify what health-related topic you need help with, and I\'ll do my best to provide useful information.';
    }

    if (message.includes('should i see') || message.includes('doctor') || message.includes('medical attention')) {
        return '👨‍⚕️ If you\'re concerned about your health symptoms, it\'s always best to consult with a healthcare professional. They can provide proper diagnosis and treatment recommendations based on your specific situation.';
    }

    // Default responses for various cases
    const defaultResponses = [
        '🏥 I\'m here to provide general health information. Could you tell me more about your specific health concern or question?',
        '💊 I can help with general health topics like symptoms, wellness, and when to seek medical care. What would you like to know about?',
        '🩺 As your AI health assistant, I can provide general medical information. Please share your specific health question or concern.',
        '🌟 I\'m designed to help with health-related questions. Feel free to ask about symptoms, wellness tips, or general health information.',
    ];

    return defaultResponses[Math.floor(Math.random() * defaultResponses.length)] + 
           '\n\n⚠️ **Remember**: Always consult healthcare professionals for proper medical advice and diagnosis.';
}

// Start the server
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 HealthEye Chatbot Server (standalone) listening on ${PORT}`);
    });
}

// Export for Vercel serverless
module.exports = app;
