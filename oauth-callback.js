require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost:3016/oauth2callback';

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname === '/oauth2callback' && parsed.query.code) {
        const code = parsed.query.code;
        console.log('Code reçu:', code);

        // Échange du code contre un token
        const postData = new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code'
        }).toString();

        const options = {
            hostname: 'oauth2.googleapis.com',
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const tokenReq = https.request(options, (tokenRes) => {
            let data = '';
            tokenRes.on('data', chunk => data += chunk);
            tokenRes.on('end', () => {
                const tokens = JSON.parse(data);
                console.log('Tokens reçus:', JSON.stringify(tokens, null, 2));
                fs.writeFileSync('/home/lydstyl/.openclaw/gmail-tokens.json', JSON.stringify(tokens, null, 2));
                console.log('Tokens sauvegardés dans /home/lydstyl/.openclaw/gmail-tokens.json');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>✅ Connexion Gmail réussie !</h1><p>Tu peux fermer cette fenêtre et revenir dans OpenClaw.</p>');
                server.close();
            });
        });

        tokenReq.on('error', (e) => {
            console.error('Erreur token:', e);
            res.writeHead(500);
            res.end('Erreur lors de l\'échange du token');
        });

        tokenReq.write(postData);
        tokenReq.end();
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(3016, '127.0.0.1', () => {
    console.log('Serveur OAuth en attente sur http://localhost:3016...');
});
