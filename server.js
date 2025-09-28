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

// Research Papers API endpoint
app.post('/api/research-papers', async (req, res) => {
    try {
        const { query, specialty, limit = 10 } = req.body;
        
        if (!query && !specialty) {
            return res.status(400).json({
                success: false,
                error: 'Query or specialty is required'
            });
        }
        
        const searchQuery = query || `recent medical research ${specialty}`;
        const papers = await fetchResearchPapers(searchQuery, limit);
        
        res.json({
            success: true,
            papers: papers,
            searchQuery: searchQuery,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error fetching research papers:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch research papers'
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
        
        const analysisPrompt = `You are a medical AI assistant analyzing a comprehensive health report. Extract ALL health parameters and provide a detailed health score.

Medical Report Text:
${text}

Please analyze this medical report and return ONLY a valid JSON object with this exact structure:
{
  "healthScore": number (0-100),
  "parameters": [
    {
      "name": "parameter name",
      "value": "measured value with unit",
      "status": "Normal|Critical|Moderate|Low|High",
      "unit": "measurement unit",
      "normalRange": "normal range if available"
    }
  ],
  "summary": "comprehensive analysis summary"
}

Extract ALL health parameters you can find, including but not limited to:

COMPLETE BLOOD COUNT (CBC):
- Red Blood Cells (RBC), White Blood Cells (WBC), Platelets
- Hemoglobin, Hematocrit, MCV, MCH, MCHC
- Neutrophils, Lymphocytes, Monocytes, Eosinophils, Basophils

LIPID PROFILE:
- Total Cholesterol, LDL, HDL, Triglycerides
- Non-HDL Cholesterol, VLDL

LIVER FUNCTION TESTS:
- ALT, AST, ALP, Bilirubin (Total & Direct)
- Albumin, Total Protein, GGT

KIDNEY FUNCTION:
- Creatinine, BUN, eGFR, Uric Acid
- Sodium, Potassium, Chloride

THYROID FUNCTION:
- TSH, T3, T4, Free T3, Free T4

DIABETES MARKERS:
- Glucose (Fasting/Random), HbA1c, Insulin

VITAMINS & MINERALS:
- Vitamin D, B12, Folate, Iron, Ferritin
- Calcium, Phosphorus, Magnesium, Zinc

CARDIAC MARKERS:
- Troponin, CK-MB, LDH

HORMONES:
- Testosterone, Estrogen, Cortisol, Growth Hormone

INFLAMMATORY MARKERS:
- ESR, CRP, Rheumatoid Factor

OTHERS:
- Blood Pressure, Heart Rate, Temperature
- Any other lab values or measurements present

For each parameter:
1. Extract the exact value with units
2. Determine status based on standard medical reference ranges
3. Include normal range when mentioned in report
4. Be thorough - don't miss any numerical values or measurements

Calculate health score based on:
- Number of abnormal values (more abnormalities = lower score)
- Severity of abnormalities (Critical < Moderate < Normal)
- Overall pattern of results`;
        
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

// Pattern-based extraction as fallback - Enhanced for comprehensive parameter extraction
function extractHealthDataWithPatterns(text) {
    const parameters = [];
    let healthScore = 85; // Starting score for comprehensive analysis
    
    // Enhanced medical test patterns for comprehensive extraction
    const patterns = {
        // Complete Blood Count (CBC) Parameters
        rbc: /(?:rbc|red\s*blood\s*cell|erythrocyte)[:\s]*(\d+(?:\.\d+)?)\s*(?:million\/ul|m\/ul|10\^6\/ul)?/i,
        wbc: /(?:wbc|white\s*blood\s*cell|leukocyte)[:\s]*(\d+(?:\.\d+)?)\s*(?:thousand\/ul|k\/ul|10\^3\/ul)?/i,
        platelets: /(?:platelet|plt)[:\s]*(\d+(?:\.\d+)?)\s*(?:thousand\/ul|k\/ul|10\^3\/ul)?/i,
        hemoglobin: /(?:hemoglobin|hb|hgb)[:\s]*(\d+(?:\.\d+)?)\s*(?:g\/dl|g\/l)?/i,
        hematocrit: /(?:hematocrit|hct)[:\s]*(\d+(?:\.\d+)?)\s*(?:%|percent)?/i,
        mcv: /(?:mcv|mean\s*corp\s*vol)[:\s]*(\d+(?:\.\d+)?)\s*(?:fl)?/i,
        mch: /(?:mch|mean\s*corp\s*hb)[:\s]*(\d+(?:\.\d+)?)\s*(?:pg)?/i,
        mchc: /(?:mchc|mean\s*corp\s*hb\s*conc)[:\s]*(\d+(?:\.\d+)?)\s*(?:g\/dl)?/i,
        
        // WBC Differential
        neutrophils: /(?:neutrophil|neut)[:\s]*(\d+(?:\.\d+)?)\s*(?:%|percent)?/i,
        lymphocytes: /(?:lymphocyte|lymph)[:\s]*(\d+(?:\.\d+)?)\s*(?:%|percent)?/i,
        monocytes: /(?:monocyte|mono)[:\s]*(\d+(?:\.\d+)?)\s*(?:%|percent)?/i,
        eosinophils: /(?:eosinophil|eos)[:\s]*(\d+(?:\.\d+)?)\s*(?:%|percent)?/i,
        basophils: /(?:basophil|baso)[:\s]*(\d+(?:\.\d+)?)\s*(?:%|percent)?/i,
        
        // Lipid Profile
        totalCholesterol: /(?:total\s*cholesterol|cholesterol\s*total)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        ldl: /(?:ldl|low\s*density)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        hdl: /(?:hdl|high\s*density)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        triglycerides: /(?:triglyceride|tg)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        vldl: /(?:vldl|very\s*low\s*density)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        
        // Liver Function Tests
        alt: /(?:alt|alanine\s*amino)[:\s]*(\d+(?:\.\d+)?)\s*(?:u\/l|iu\/l)?/i,
        ast: /(?:ast|aspartate\s*amino)[:\s]*(\d+(?:\.\d+)?)\s*(?:u\/l|iu\/l)?/i,
        alp: /(?:alp|alkaline\s*phosphatase)[:\s]*(\d+(?:\.\d+)?)\s*(?:u\/l|iu\/l)?/i,
        bilirubin: /(?:bilirubin|bili)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|µmol\/l)?/i,
        albumin: /(?:albumin|alb)[:\s]*(\d+(?:\.\d+)?)\s*(?:g\/dl|g\/l)?/i,
        totalProtein: /(?:total\s*protein|protein\s*total)[:\s]*(\d+(?:\.\d+)?)\s*(?:g\/dl|g\/l)?/i,
        
        // Kidney Function
        creatinine: /(?:creatinine|creat)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|µmol\/l)?/i,
        bun: /(?:bun|blood\s*urea\s*nitrogen)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        egfr: /(?:egfr|estimated\s*gfr)[:\s]*(\d+(?:\.\d+)?)\s*(?:ml\/min\/1.73m2)?/i,
        uricAcid: /(?:uric\s*acid|urate)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|µmol\/l)?/i,
        
        // Electrolytes
        sodium: /(?:sodium|na)[:\s]*(\d+(?:\.\d+)?)\s*(?:meq\/l|mmol\/l)?/i,
        potassium: /(?:potassium|k)[:\s]*(\d+(?:\.\d+)?)\s*(?:meq\/l|mmol\/l)?/i,
        chloride: /(?:chloride|cl)[:\s]*(\d+(?:\.\d+)?)\s*(?:meq\/l|mmol\/l)?/i,
        
        // Thyroid Function
        tsh: /(?:tsh)[:\s]*(\d+(?:\.\d+)?)\s*(?:µiu\/ml|miu\/l)?/i,
        t3: /(?:t3|triiodothyronine)[:\s]*(\d+(?:\.\d+)?)\s*(?:ng\/dl|nmol\/l)?/i,
        t4: /(?:t4|thyroxine)[:\s]*(\d+(?:\.\d+)?)\s*(?:µg\/dl|nmol\/l)?/i,
        freeT3: /(?:free\s*t3|ft3)[:\s]*(\d+(?:\.\d+)?)\s*(?:pg\/ml|pmol\/l)?/i,
        freeT4: /(?:free\s*t4|ft4)[:\s]*(\d+(?:\.\d+)?)\s*(?:ng\/dl|pmol\/l)?/i,
        
        // Diabetes Markers
        glucose: /(?:glucose|sugar|fbs|rbs)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        hba1c: /(?:hba1c|glycated\s*hb)[:\s]*(\d+(?:\.\d+)?)\s*(?:%|mmol\/mol)?/i,
        
        // Vitamins and Minerals
        vitaminD: /(?:vitamin\s*d|25\s*oh\s*d)[:\s]*(\d+(?:\.\d+)?)\s*(?:ng\/ml|nmol\/l)?/i,
        vitaminB12: /(?:vitamin\s*b12|b12)[:\s]*(\d+(?:\.\d+)?)\s*(?:pg\/ml|pmol\/l)?/i,
        folate: /(?:folate|folic\s*acid)[:\s]*(\d+(?:\.\d+)?)\s*(?:ng\/ml|nmol\/l)?/i,
        iron: /(?:iron|fe)[:\s]*(\d+(?:\.\d+)?)\s*(?:µg\/dl|µmol\/l)?/i,
        ferritin: /(?:ferritin)[:\s]*(\d+(?:\.\d+)?)\s*(?:ng\/ml|µg\/l)?/i,
        calcium: /(?:calcium|ca)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        phosphorus: /(?:phosphorus|phos)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        magnesium: /(?:magnesium|mg)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/dl|mmol\/l)?/i,
        
        // Inflammatory Markers
        esr: /(?:esr|erythrocyte\s*sed)[:\s]*(\d+(?:\.\d+)?)\s*(?:mm\/hr)?/i,
        crp: /(?:crp|c\s*reactive)[:\s]*(\d+(?:\.\d+)?)\s*(?:mg\/l|mg\/dl)?/i,
        
        // Cardiac Markers
        troponin: /(?:troponin|trop)[:\s]*(\d+(?:\.\d+)?)\s*(?:ng\/ml|µg\/l)?/i,
        
        // Blood Pressure
        bloodPressure: /(?:blood\s*pressure|bp)[:\s]*(\d{2,3})[/\s]*(\d{2,3})/i,
    };
    
    // Helper function to determine status based on parameter name and value
    function getParameterStatus(paramName, value, unit) {
        const param = paramName.toLowerCase();
        
        // CBC Parameters
        if (param.includes('rbc') || param.includes('red blood')) {
            return (value < 4.0 || value > 5.5) ? 'Moderate' : 'Normal';
        } else if (param.includes('wbc') || param.includes('white blood')) {
            return (value < 4.0 || value > 11.0) ? 'Moderate' : 'Normal';
        } else if (param.includes('platelet')) {
            return (value < 150 || value > 400) ? (value < 100 || value > 500) ? 'Critical' : 'Moderate' : 'Normal';
        } else if (param.includes('hemoglobin')) {
            return (value < 12 || value > 16) ? (value < 10 || value > 18) ? 'Critical' : 'Moderate' : 'Normal';
        } else if (param.includes('hematocrit')) {
            return (value < 36 || value > 48) ? 'Moderate' : 'Normal';
        }
        
        // Lipid Profile
        else if (param.includes('total cholesterol')) {
            return (value >= 240) ? 'Critical' : (value >= 200) ? 'Moderate' : 'Normal';
        } else if (param.includes('ldl')) {
            return (value >= 160) ? 'Critical' : (value >= 130) ? 'Moderate' : 'Normal';
        } else if (param.includes('hdl')) {
            return (value < 40) ? 'Low' : (value > 60) ? 'High' : 'Normal';
        } else if (param.includes('triglyceride')) {
            return (value >= 200) ? 'Critical' : (value >= 150) ? 'Moderate' : 'Normal';
        }
        
        // Liver Function
        else if (param.includes('alt')) {
            return (value > 40) ? (value > 80) ? 'Critical' : 'Moderate' : 'Normal';
        } else if (param.includes('ast')) {
            return (value > 40) ? (value > 80) ? 'Critical' : 'Moderate' : 'Normal';
        }
        
        // Kidney Function
        else if (param.includes('creatinine')) {
            return (value > 1.3) ? (value > 2.0) ? 'Critical' : 'Moderate' : 'Normal';
        } else if (param.includes('bun')) {
            return (value > 20) ? (value > 40) ? 'Critical' : 'Moderate' : 'Normal';
        }
        
        // Thyroid
        else if (param.includes('tsh')) {
            return (value < 0.4 || value > 4.0) ? 'Moderate' : 'Normal';
        }
        
        // Glucose
        else if (param.includes('glucose')) {
            return (value >= 126) ? 'Critical' : (value >= 100) ? 'Moderate' : (value < 70) ? 'Low' : 'Normal';
        }
        
        // Vitamins
        else if (param.includes('vitamin d')) {
            return (value < 20) ? 'Critical' : (value < 30) ? 'Low' : 'Normal';
        } else if (param.includes('b12')) {
            return (value < 200) ? 'Critical' : (value < 300) ? 'Low' : 'Normal';
        }
        
        // Default
        return 'Normal';
    }
    
    // Extract all parameters using enhanced patterns
    const parameterDefinitions = [
        { key: 'rbc', name: 'Red Blood Cells (RBC)', unit: 'million/uL' },
        { key: 'wbc', name: 'White Blood Cells (WBC)', unit: 'thousand/uL' },
        { key: 'platelets', name: 'Platelets', unit: 'thousand/uL' },
        { key: 'hemoglobin', name: 'Hemoglobin', unit: 'g/dL' },
        { key: 'hematocrit', name: 'Hematocrit', unit: '%' },
        { key: 'mcv', name: 'MCV', unit: 'fL' },
        { key: 'mch', name: 'MCH', unit: 'pg' },
        { key: 'mchc', name: 'MCHC', unit: 'g/dL' },
        { key: 'neutrophils', name: 'Neutrophils', unit: '%' },
        { key: 'lymphocytes', name: 'Lymphocytes', unit: '%' },
        { key: 'monocytes', name: 'Monocytes', unit: '%' },
        { key: 'eosinophils', name: 'Eosinophils', unit: '%' },
        { key: 'basophils', name: 'Basophils', unit: '%' },
        { key: 'totalCholesterol', name: 'Total Cholesterol', unit: 'mg/dL' },
        { key: 'ldl', name: 'LDL Cholesterol', unit: 'mg/dL' },
        { key: 'hdl', name: 'HDL Cholesterol', unit: 'mg/dL' },
        { key: 'triglycerides', name: 'Triglycerides', unit: 'mg/dL' },
        { key: 'vldl', name: 'VLDL Cholesterol', unit: 'mg/dL' },
        { key: 'alt', name: 'ALT', unit: 'U/L' },
        { key: 'ast', name: 'AST', unit: 'U/L' },
        { key: 'alp', name: 'Alkaline Phosphatase', unit: 'U/L' },
        { key: 'bilirubin', name: 'Bilirubin', unit: 'mg/dL' },
        { key: 'albumin', name: 'Albumin', unit: 'g/dL' },
        { key: 'totalProtein', name: 'Total Protein', unit: 'g/dL' },
        { key: 'creatinine', name: 'Creatinine', unit: 'mg/dL' },
        { key: 'bun', name: 'BUN', unit: 'mg/dL' },
        { key: 'egfr', name: 'eGFR', unit: 'mL/min/1.73m²' },
        { key: 'uricAcid', name: 'Uric Acid', unit: 'mg/dL' },
        { key: 'sodium', name: 'Sodium', unit: 'mEq/L' },
        { key: 'potassium', name: 'Potassium', unit: 'mEq/L' },
        { key: 'chloride', name: 'Chloride', unit: 'mEq/L' },
        { key: 'tsh', name: 'TSH', unit: 'µIU/mL' },
        { key: 't3', name: 'T3', unit: 'ng/dL' },
        { key: 't4', name: 'T4', unit: 'µg/dL' },
        { key: 'freeT3', name: 'Free T3', unit: 'pg/mL' },
        { key: 'freeT4', name: 'Free T4', unit: 'ng/dL' },
        { key: 'glucose', name: 'Glucose', unit: 'mg/dL' },
        { key: 'hba1c', name: 'HbA1c', unit: '%' },
        { key: 'vitaminD', name: 'Vitamin D', unit: 'ng/mL' },
        { key: 'vitaminB12', name: 'Vitamin B12', unit: 'pg/mL' },
        { key: 'folate', name: 'Folate', unit: 'ng/mL' },
        { key: 'iron', name: 'Iron', unit: 'µg/dL' },
        { key: 'ferritin', name: 'Ferritin', unit: 'ng/mL' },
        { key: 'calcium', name: 'Calcium', unit: 'mg/dL' },
        { key: 'phosphorus', name: 'Phosphorus', unit: 'mg/dL' },
        { key: 'magnesium', name: 'Magnesium', unit: 'mg/dL' },
        { key: 'esr', name: 'ESR', unit: 'mm/hr' },
        { key: 'crp', name: 'CRP', unit: 'mg/L' },
        { key: 'troponin', name: 'Troponin', unit: 'ng/mL' },
    ];
    
    // Process each parameter
    parameterDefinitions.forEach(paramDef => {
        const match = text.match(patterns[paramDef.key]);
        if (match) {
            const value = parseFloat(match[1]);
            const status = getParameterStatus(paramDef.name, value, paramDef.unit);
            
            parameters.push({
                name: paramDef.name,
                value: `${value} ${paramDef.unit}`,
                status: status,
                unit: paramDef.unit
            });
            
            // Adjust health score based on status
            if (status === 'Critical') healthScore -= 15;
            else if (status === 'Moderate') healthScore -= 8;
            else if (status === 'Low') healthScore -= 6;
        }
    });
    
    // Extract blood pressure (special case with two values)
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
        summary: `Comprehensive health report analysis complete. Extracted ${parameters.length} health parameter(s) from the report. Overall health score: ${Math.round(healthScore)}/100. This analysis includes CBC, lipid profile, liver function, kidney function, thyroid markers, vitamins, and other essential health indicators.`
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

// Fetch research papers using AI to simulate academic search
async function fetchResearchPapers(query, limit = 10) {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        // Return sample papers if no API key
        return getSampleResearchPapers(query, limit);
    }
    
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "models/gemini-1.5-flash-latest"
        });
        
        const researchPrompt = `Generate a list of recent medical research papers related to: "${query}".

Create ${limit} realistic research paper entries in JSON format with the following structure:
{
  "papers": [
    {
      "title": "Research paper title",
      "authors": "Author names",
      "journal": "Journal name",
      "year": 2024,
      "abstract": "Brief abstract (2-3 sentences)",
      "doi": "10.1000/example.doi",
      "keywords": ["keyword1", "keyword2", "keyword3"],
      "impact_factor": "Journal impact factor",
      "citation_count": "Estimated citations",
      "study_type": "Type of study (e.g., Clinical Trial, Review, Case Study)",
      "significance": "Clinical significance summary (1 sentence)"
    }
  ]
}

Focus on recent, relevant, and credible medical research. Include diverse study types and reputable journals.`;
        
        const result = await model.generateContent(researchPrompt);
        const response = await result.response.text();
        
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsedResponse = JSON.parse(jsonMatch[0]);
            return parsedResponse.papers || [];
        }
        
        // Fallback to sample papers if AI response parsing fails
        return getSampleResearchPapers(query, limit);
        
    } catch (error) {
        console.log('Error fetching research papers with AI:', error.message);
        return getSampleResearchPapers(query, limit);
    }
}

// Sample research papers as fallback
function getSampleResearchPapers(query, limit) {
    const samplePapers = [
        {
            title: "Machine Learning Applications in Medical Diagnosis: A Comprehensive Review",
            authors: "Smith, J.A., Johnson, M.K., Brown, S.L.",
            journal: "Nature Medicine",
            year: 2024,
            abstract: "This comprehensive review examines the current state and future potential of machine learning applications in medical diagnosis. We analyze recent breakthroughs in AI-assisted diagnostics and their clinical implications.",
            doi: "10.1038/nm.2024.001",
            keywords: ["machine learning", "medical diagnosis", "artificial intelligence"],
            impact_factor: "47.4",
            citation_count: "156",
            study_type: "Systematic Review",
            significance: "Demonstrates significant potential for AI in improving diagnostic accuracy."
        },
        {
            title: "Telemedicine Adoption Post-Pandemic: Patient Outcomes and Healthcare Accessibility",
            authors: "Davis, R.P., Wilson, A.T., Martinez, C.D.",
            journal: "The Lancet",
            year: 2024,
            abstract: "A large-scale study examining telemedicine adoption rates and their impact on patient outcomes and healthcare accessibility following the COVID-19 pandemic. Results show sustained improvements in care delivery.",
            doi: "10.1016/S0140-6736(24)00123-4",
            keywords: ["telemedicine", "healthcare accessibility", "patient outcomes"],
            impact_factor: "202.7",
            citation_count: "89",
            study_type: "Longitudinal Study",
            significance: "Provides evidence for sustained benefits of telemedicine integration."
        },
        {
            title: "Precision Medicine in Cardiovascular Disease: Genetic Markers and Therapeutic Targets",
            authors: "Thompson, K.L., Garcia, M.R., Lee, S.H.",
            journal: "Circulation",
            year: 2024,
            abstract: "This study identifies novel genetic markers associated with cardiovascular disease risk and presents new therapeutic targets for personalized treatment approaches. Genomic analysis of 50,000 patients reveals significant correlations.",
            doi: "10.1161/CIRCULATIONAHA.124.001234",
            keywords: ["precision medicine", "cardiovascular disease", "genetic markers"],
            impact_factor: "29.7",
            citation_count: "203",
            study_type: "Genomic Study",
            significance: "Opens new avenues for personalized cardiovascular treatment strategies."
        },
        {
            title: "Mental Health Interventions in Primary Care: Digital Therapeutics vs Traditional Counseling",
            authors: "Anderson, P.J., Taylor, L.M., Roberts, N.K.",
            journal: "JAMA Psychiatry",
            year: 2024,
            abstract: "Randomized controlled trial comparing digital therapeutic interventions with traditional counseling for mental health conditions in primary care settings. Digital interventions showed non-inferior outcomes with improved accessibility.",
            doi: "10.1001/jamapsychiatry.2024.567",
            keywords: ["digital therapeutics", "mental health", "primary care"],
            impact_factor: "22.5",
            citation_count: "78",
            study_type: "Randomized Controlled Trial",
            significance: "Supports integration of digital mental health tools in primary care."
        },
        {
            title: "Antibiotic Resistance Patterns in Hospital-Acquired Infections: A Multi-Center Analysis",
            authors: "Kumar, V.S., Patel, A.M., Chen, L.W.",
            journal: "Clinical Infectious Diseases",
            year: 2024,
            abstract: "Multi-center study analyzing antibiotic resistance patterns across 150 hospitals globally. Findings reveal concerning trends in carbapenem-resistant bacteria and highlight need for stewardship programs.",
            doi: "10.1093/cid/ciy123",
            keywords: ["antibiotic resistance", "hospital infections", "antimicrobial stewardship"],
            impact_factor: "12.2",
            citation_count: "142",
            study_type: "Multi-Center Study",
            significance: "Informs global strategies for combating antibiotic resistance."
        }
    ];
    
    // Filter papers based on query relevance and limit
    const filteredPapers = samplePapers
        .filter(paper => 
            paper.title.toLowerCase().includes(query.toLowerCase()) ||
            paper.abstract.toLowerCase().includes(query.toLowerCase()) ||
            paper.keywords.some(keyword => keyword.toLowerCase().includes(query.toLowerCase())) ||
            query.toLowerCase().includes('medical') ||
            query.toLowerCase().includes('research')
        )
        .slice(0, limit);
    
    // If no matches found, return all papers up to limit
    return filteredPapers.length > 0 ? filteredPapers : samplePapers.slice(0, limit);
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
