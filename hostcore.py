from flask import Flask
from pyngrok import ngrok

app = Flask(__name__)

@app.route('/')
def home():
    return "<h1>Hello from your local Python server!</h1><p>Served via Flask + ngrok.</p>"

@app.route('/status')
def status():
    return '''
    <html>
    <head>
        <style>
            body {
                font-family: sans-serif;
                margin: 0;
                padding: 0;
                width: 100px;
                height: 100px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                text-align: center;
                background: #f0fff0;
            }
            .circle {
                width: 20px;
                height: 20px;
                background-color: green;
                border-radius: 50%;
                margin-bottom: 5px;
            }
        </style>
    </head>
    <body>
        <div class="circle"></div>
        <div><strong>ONLINE!</strong></div>
    </body>
    </html>
    '''

if __name__ == '__main__':
    public_url = ngrok.connect(5000)
    print("🌍 Public URL:", public_url)
    print("🚀 App running at http://127.0.0.1:5000")

    app.run()
