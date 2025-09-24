#!/usr/bin/env python3
"""
TensorFlow Model Prediction Server for HealthEye
Serves image classification predictions with proper preprocessing
"""

import os
import io
import base64
import numpy as np
import tensorflow as tf
from flask import Flask, request, jsonify
from flask_cors import CORS
from PIL import Image
import json

app = Flask(__name__)
CORS(app)

# Model configuration matching your training code
IMG_SIZE = (224, 224)
NUM_CLASSES = 23

# Load class labels
class_labels = [
    'barretts',
    'barretts-short-segment', 
    'bbps-0-1',
    'bbps-2-3',
    'cecum',
    'dyed-lifted-polyps',
    'dyed-resection-margins',
    'esophagitis-a',
    'esophagitis-b-d',
    'hemorrhoids',
    'ileum',
    'impacted-stool',
    'polyps',
    'pylorus',
    'retroflex-rectum',
    'retroflex-stomach',
    'ulcerative-colitis-grade-0-1',
    'ulcerative-colitis-grade-1',
    'ulcerative-colitis-grade-1-2',
    'ulcerative-colitis-grade-2',
    'ulcerative-colitis-grade-2-3',
    'ulcerative-colitis-grade-3',
    'z-line'
]

# Global model variable
model = None
model_loaded = False
model_error = None
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Prefer lightweight tflite-runtime if available; fallback to TensorFlow Lite
try:
    from tflite_runtime.interpreter import Interpreter as TFLiteInterpreter  # type: ignore
    TFLITE_BACKEND = 'tflite-runtime'
except Exception:
    TFLiteInterpreter = tf.lite.Interpreter  # type: ignore
    TFLITE_BACKEND = 'tensorflow'

def preprocess_image(image_bytes):
    """
    Preprocess image to match your model's training pipeline:
    1. Decode image
    2. Resize to (224, 224) 
    3. Normalize to 0.0-1.0 range
    4. EfficientNet preprocessing is applied by the model internally
    """
    try:
        # Decode image from bytes
        image = Image.open(io.BytesIO(image_bytes))
        
        # Convert to RGB if needed (handle PNG transparency, RGBA, etc.)
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Resize to model input size with anti-aliasing (matches tf.image.resize antialias=True)
        image = image.resize(IMG_SIZE, Image.Resampling.LANCZOS)
        
        # Convert to numpy array and normalize to 0.0-1.0 (matches training pipeline)
        img_array = np.array(image, dtype=np.float32) / 255.0
        
        # Add batch dimension
        img_array = np.expand_dims(img_array, axis=0)
        
        print(f"Preprocessed image shape: {img_array.shape}")
        print(f"Preprocessed image range: [{img_array.min():.3f}, {img_array.max():.3f}]")
        
        return img_array
        
    except Exception as e:
        print(f"Error in image preprocessing: {e}")
        raise e

def load_model():
    """Load the TensorFlow model"""
    global model, model_loaded, model_error
    
    try:
        # Look for model files in the assets directory
        # Allow override via environment variable
        env_model_path = os.getenv('TFLITE_MODEL_PATH')
        search_paths = []
        if env_model_path:
            search_paths.append(env_model_path)
        # Search common locations relative to backend folder and repo root
        search_paths.extend([
            os.path.join(BASE_DIR, 'assets', 'models', 'model.tflite'),
            os.path.join(BASE_DIR, 'assets', 'models', 'model_32.tflite'),
            os.path.join(BASE_DIR, 'model.tflite'),
            os.path.join(BASE_DIR, 'model_32.tflite'),
            os.path.join(BASE_DIR, '..', 'assets', 'models', 'model.tflite'),
            os.path.join(BASE_DIR, '..', 'assets', 'models', 'model_32.tflite'),
            os.path.join(BASE_DIR, '..', 'models', 'model.tflite'),
            os.path.join(BASE_DIR, '..', 'models', 'model_32.tflite'),
        ])
        
        model_path = None
        for path in search_paths:
            if os.path.exists(path):
                model_path = path
                break

        if model_path is None:
            raise FileNotFoundError(f"Model file not found. Searched paths: {search_paths}")

        print(f"Loading model from: {model_path} (backend: {TFLITE_BACKEND})")

        # Load TFLite model
        interpreter = TFLiteInterpreter(model_path=model_path)
        interpreter.allocate_tensors()
        
        # Get input and output details
        input_details = interpreter.get_input_details()
        output_details = interpreter.get_output_details()
        
        print(f"Model input shape: {input_details[0]['shape']}")
        print(f"Model output shape: {output_details[0]['shape']}")
        
        model = {
            'interpreter': interpreter,
            'input_details': input_details,
            'output_details': output_details
        }
        
        model_loaded = True
        model_error = None
        print("✅ Model loaded successfully!")
        
    except Exception as e:
        model_error = str(e)
        model_loaded = False
        print(f"❌ Error loading model: {e}")

def predict_image(img_array):
    """Make prediction using the loaded model"""
    global model
    
    if not model_loaded or model is None:
        raise Exception("Model not loaded")
    
    try:
        interpreter = model['interpreter']
        input_details = model['input_details']
        output_details = model['output_details']
        
        # Set input tensor
        interpreter.set_tensor(input_details[0]['index'], img_array)
        
        # Run inference
        interpreter.invoke()
        
        # Get prediction
        predictions = interpreter.get_tensor(output_details[0]['index'])
        
        return predictions[0]  # Remove batch dimension
        
    except Exception as e:
        print(f"Error during prediction: {e}")
        raise e

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'OK',
        'message': 'TensorFlow Prediction Server is running',
        'model_loaded': model_loaded,
        'model_error': model_error,
        'can_predict': model_loaded and model_error is None,
        'model_info': {
            'num_classes': NUM_CLASSES,
            'input_size': IMG_SIZE,
            'class_labels_count': len(class_labels),
            'backend': TFLITE_BACKEND
        }
    })

@app.route('/predict', methods=['POST'])
def predict():
    """Main prediction endpoint"""
    try:
        if not model_loaded:
            return jsonify({
                'success': False,
                'error': f'Model not loaded: {model_error}'
            }), 500
        
        # Get image from request
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({
                'success': False,
                'error': 'No image data provided'
            }), 400
        
        # Decode base64 image
        try:
            image_b64 = data['image']
            image_bytes = base64.b64decode(image_b64)
            print(f"Received image: {len(image_bytes)} bytes")
        except Exception as e:
            return jsonify({
                'success': False,
                'error': f'Invalid base64 image data: {e}'
            }), 400
        
        # Preprocess image
        try:
            img_array = preprocess_image(image_bytes)
        except Exception as e:
            return jsonify({
                'success': False,
                'error': f'Image preprocessing failed: {e}'
            }), 400
        
        # Make prediction
        try:
            predictions = predict_image(img_array)
            print(f"Raw predictions shape: {predictions.shape}")
            print(f"Raw predictions: {predictions}")
        except Exception as e:
            return jsonify({
                'success': False,
                'error': f'Prediction failed: {e}'
            }), 500
        
        # Format results
        top_indices = np.argsort(predictions)[::-1]  # Sort in descending order
        
        # Get top 5 predictions
        top_5_predictions = []
        for i in range(min(5, len(top_indices))):
            idx = top_indices[i]
            confidence = float(predictions[idx])
            label = class_labels[idx] if idx < len(class_labels) else f"Class_{idx}"
            
            top_5_predictions.append({
                'label': label,
                'confidence': confidence,
                'percentage': confidence * 100
            })
        
        # Get the top prediction
        top_prediction = top_5_predictions[0] if top_5_predictions else None
        
        result = {
            'success': True,
            'result': {
                'prediction': top_prediction['label'] if top_prediction else 'unknown',
                'confidence': top_prediction['confidence'] if top_prediction else 0.0,
                'percentage': top_prediction['percentage'] if top_prediction else 0.0,
                'top_5_predictions': top_5_predictions,
                'model_info': {
                    'preprocessing': 'resize_224x224_normalize_0_1',
                    'model_type': 'EfficientNetB0',
                    'num_classes': NUM_CLASSES
                }
            }
        }
        
        print(f"Returning prediction: {top_prediction['label'] if top_prediction else 'unknown'} ({top_prediction['percentage']:.2f}%)")
        return jsonify(result)
        
    except Exception as e:
        print(f"Unexpected error in /predict: {e}")
        return jsonify({
            'success': False,
            'error': f'Internal server error: {e}'
        }), 500

@app.route('/', methods=['GET'])
def root():
    """Root endpoint"""
    return jsonify({
        'message': 'HealthEye TensorFlow Prediction Server',
        'version': '1.0.0',
        'status': 'running',
        'model_loaded': model_loaded,
        'endpoints': {
            'health': 'GET /health',
            'predict': 'POST /predict'
        }
    })

# Preload model at import time (suitable for gunicorn/render)
try:
    print("📊 Loading TFLite model at startup...")
    load_model()
except Exception as e:
    print(f"❌ Exception during model preload: {e}")

if __name__ == '__main__':
    # Dev server only; gunicorn is used in production
    print("🧠 Starting HealthEye TensorFlow Prediction Server (dev mode)...")
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 5000)), debug=True)