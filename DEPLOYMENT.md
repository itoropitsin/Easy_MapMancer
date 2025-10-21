# Deployment Guide

This guide covers different deployment options for DnD Map Maker.

## 🚀 Quick Deployment

### Local Development
```bash
git clone https://github.com/yourusername/dnd-map-maker.git
cd dnd-map-maker
npm install
npm run dev
```

### Production Build
```bash
npm run build
npm start
```

## 🌐 Web Deployment

### Option 1: Vercel (Recommended)

1. **Connect your repository** to Vercel
2. **Configure build settings**:
   - Build Command: `npm run build`
   - Output Directory: `packages/client/dist`
   - Install Command: `npm install`

3. **Environment Variables**:
   - `NODE_ENV=production`
   - `PORT=8080` (or your preferred port)

4. **Deploy**: Vercel will automatically deploy on every push to main

### Option 2: Netlify

1. **Connect repository** to Netlify
2. **Build settings**:
   - Build command: `npm run build`
   - Publish directory: `packages/client/dist`
   - Node version: `18`

3. **Deploy**: Automatic deployment on git push

### Option 3: GitHub Pages

1. **Enable GitHub Pages** in repository settings
2. **Use GitHub Actions** workflow:
   ```yaml
   # .github/workflows/deploy.yml
   name: Deploy to GitHub Pages
   on:
     push:
       branches: [ main ]
   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: '20'
         - run: npm ci
         - run: npm run build
         - uses: peaceiris/actions-gh-pages@v3
           with:
             github_token: ${{ secrets.GITHUB_TOKEN }}
             publish_dir: ./packages/client/dist
   ```

## 🖥️ Server Deployment

### Docker Deployment

1. **Create Dockerfile**:
   ```dockerfile
   FROM node:18-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --only=production
   COPY . .
   RUN npm run build
   EXPOSE 8080
   CMD ["npm", "start"]
   ```

2. **Build and run**:
   ```bash
   docker build -t dnd-map-maker .
   docker run -p 8080:8080 dnd-map-maker
   ```

### Traditional Server

1. **Install Node.js 18+** on your server
2. **Clone repository**:
   ```bash
   git clone https://github.com/yourusername/dnd-map-maker.git
   cd dnd-map-maker
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Build project**:
   ```bash
   npm run build
   ```

5. **Start server**:
   ```bash
   npm start
   ```

6. **Configure reverse proxy** (nginx example):
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:8080;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

## 🔧 Environment Configuration

### Required Environment Variables

- `NODE_ENV`: Set to `production` for production builds
- `PORT`: Server port (default: 8080)
- `LOCATIONS_DIR`: Directory for map storage (default: `packages/server/data/locations`)

### Optional Environment Variables

- `MAX_PORT`: Maximum port for automatic port search (default: PORT + 20)

### Example Configuration

```bash
# Production environment
NODE_ENV=production
PORT=8080
LOCATIONS_DIR=/var/lib/dnd-map-maker/maps

# Development environment
NODE_ENV=development
PORT=8080
LOCATIONS_DIR=./packages/server/data/locations
```

## 📊 Monitoring and Logging

### Health Check Endpoint

The server provides a health check at `http://localhost:8080/`:

```bash
curl http://localhost:8080/
# Should return: {"status":"ok","timestamp":"..."}
```

### Logging

- **Console logs**: All server events are logged to console
- **Error handling**: Errors are logged with stack traces
- **WebSocket events**: Connection/disconnection events are logged

### Performance Monitoring

- **Memory usage**: Monitor Node.js memory consumption
- **WebSocket connections**: Track active connections
- **File system**: Monitor map storage usage

## 🔒 Security Considerations

### Production Security

1. **Use HTTPS**: Always use HTTPS in production
2. **Firewall**: Restrict access to necessary ports only
3. **Updates**: Keep dependencies updated
4. **Backups**: Regular backups of map data
5. **Monitoring**: Monitor for suspicious activity

### Reverse Proxy Configuration

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 🚨 Troubleshooting

### Common Issues

1. **Port already in use**:
   ```bash
   PORT=9090 npm start
   ```

2. **Permission denied**:
   ```bash
   sudo chown -R $USER:$USER /path/to/maps
   ```

3. **Build failures**:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   npm run build
   ```

4. **WebSocket connection issues**:
   - Check firewall settings
   - Verify reverse proxy configuration
   - Check browser console for errors

### Debug Mode

Enable debug logging:
```bash
DEBUG=* npm start
```

## 📈 Scaling

### Horizontal Scaling

- **Load balancer**: Distribute WebSocket connections
- **Session affinity**: Ensure users stay on same server
- **Shared storage**: Use shared file system for maps

### Vertical Scaling

- **Memory**: Increase Node.js heap size
- **CPU**: Use multiple cores with cluster module
- **Storage**: Use SSD for better I/O performance

## 🔄 Updates and Maintenance

### Updating the Application

1. **Pull latest changes**:
   ```bash
   git pull origin main
   ```

2. **Update dependencies**:
   ```bash
   npm install
   ```

3. **Rebuild**:
   ```bash
   npm run build
   ```

4. **Restart server**:
   ```bash
   npm start
   ```

### Backup Strategy

1. **Map data backup**:
   ```bash
   tar -czf maps-backup-$(date +%Y%m%d).tar.gz packages/server/data/locations/
   ```

2. **Automated backups**:
   ```bash
   # Add to crontab
   0 2 * * * /path/to/backup-script.sh
   ```

---

For more help, see [CONTRIBUTING.md](CONTRIBUTING.md) or open an [issue](https://github.com/yourusername/dnd-map-maker/issues).
