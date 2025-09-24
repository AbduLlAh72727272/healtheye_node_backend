@echo off
echo 🧠 HealthEye TensorFlow Prediction Server Setup
echo ================================================

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Python is not installed or not in PATH
    echo Please install Python 3.8+ from https://python.org
    pause
    exit /b 1
)

echo ✅ Python found
python --version

REM Check if virtual environment exists
if not exist "prediction_env" (
    echo 📦 Creating virtual environment...
    python -m venv prediction_env
    if errorlevel 1 (
        echo ❌ Failed to create virtual environment
        pause
        exit /b 1
    )
    echo ✅ Virtual environment created
)

REM Activate virtual environment
echo 🔄 Activating virtual environment...
call prediction_env\Scripts\activate.bat

REM Install dependencies
echo 📦 Installing dependencies...
pip install -r requirements_prediction.txt
if errorlevel 1 (
    echo ❌ Failed to install dependencies
    pause
    exit /b 1
)

echo ✅ Dependencies installed

REM Check if model file exists
echo 🔍 Checking for model files...
if exist "..\assets\models\model.tflite" (
    echo ✅ Found model.tflite
) else if exist "..\assets\models\model_32.tflite" (
    echo ✅ Found model_32.tflite
) else (
    echo ⚠️  Warning: No model file found in ../assets/models/
    echo Please ensure your trained model is saved as:
    echo   - assets/models/model.tflite
    echo   - OR assets/models/model_32.tflite
    echo.
)

echo 🚀 Starting TensorFlow Prediction Server...
echo Server will be available at: http://localhost:5000
echo Health check: http://localhost:5000/health
echo Prediction endpoint: http://localhost:5000/predict
echo.
echo Press Ctrl+C to stop the server
echo ================================================

python prediction_server.py

pause