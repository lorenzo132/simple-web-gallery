const express = require('express');
const multer = require('multer');
const SFTPClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const dotenv = require('dotenv');
const mime = require('mime-types'); // For detecting MIME type
const app = express();

// Load environment variables from .env file
dotenv.config();

// SFTP configuration from environment variables
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = process.env.SFTP_PORT || 22;
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const SFTP_DIR = process.env.SFTP_DIR || '/';

// Allowed IP address for uploading videos
const UPLOAD_ALLOWED_IP = process.env.UPLOAD_ALLOWED_IP;

// Local video storage directory
const LOCAL_VIDEO_DIR = 'local_videos/';

// Configure multer to store files in a specific directory
const upload = multer({
    dest: LOCAL_VIDEO_DIR, // Directory to store uploaded files
    limits: { fileSize: 100 * 1024 * 1024 } // Limit file size to 100 MB
});

// Ensure local video directory exists
if (!fs.existsSync(LOCAL_VIDEO_DIR)){
    fs.mkdirSync(LOCAL_VIDEO_DIR);
}

// Trust the X-Forwarded-For header to get the correct client IP if using a proxy
app.set('trust proxy', true);

// Middleware to check IP address for uploads
function ipRestrict(req, res, next) {
    const clientIp = req.ip;
    console.log(`Client IP: ${clientIp}`);
    
    if (clientIp === UPLOAD_ALLOWED_IP) {
        next();
    } else {
        res.status(403).send('Forbidden: You are not allowed to upload.');
    }
}

// Function to create a new SFTP client connection
async function createSFTPConnection() {
    const sftp = new SFTPClient();
    await sftp.connect({
        host: SFTP_HOST,
        port: SFTP_PORT,
        username: SFTP_USER,
        password: SFTP_PASSWORD
    });
    return sftp;
}

// Function to list media files from both SFTP and local directories
async function listMedia() {
    let sftp;
    const mediaItems = [];
    try {
        // List files from SFTP
        sftp = await createSFTPConnection();
        const sftpFileList = await sftp.list(SFTP_DIR);

        for (const file of sftpFileList) {
            const ext = path.extname(file.name).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/media/${encodeURIComponent(file.name)}`;
                const fileStat = await sftp.stat(path.join(SFTP_DIR, file.name));
                let uploadDate = new Date(fileStat.mtime);
                if (isNaN(uploadDate)) {
                    uploadDate = 'Unknown Date';
                }

                mediaItems.push({
                    url: fileUrl,
                    size: fileStat.size,
                    uploadDate: uploadDate instanceof Date ? uploadDate : 'Unknown Date'
                });
            }
        }

        // List files from local directory
        const localFileList = fs.readdirSync(LOCAL_VIDEO_DIR);

        for (const file of localFileList) {
            const ext = path.extname(file).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/local/${encodeURIComponent(file)}`;
                const filePath = path.join(LOCAL_VIDEO_DIR, file);
                const fileStat = fs.statSync(filePath);
                let uploadDate = new Date(fileStat.mtime);
                if (isNaN(uploadDate)) {
                    uploadDate = 'Unknown Date';
                }

                mediaItems.push({
                    url: fileUrl,
                    size: fileStat.size,
                    uploadDate: uploadDate instanceof Date ? uploadDate : 'Unknown Date'
                });
            }
        }

        mediaItems.sort((a, b) => (a.uploadDate instanceof Date && b.uploadDate instanceof Date) ? b.uploadDate - a.uploadDate : 0);

        return mediaItems;
    } catch (error) {
        console.error(error);
        return [];
    } finally {
        if (sftp) {
            await sftp.end();
        }
    }
}

// Serve static files
app.use(express.static('public'));
app.use('/local', express.static(LOCAL_VIDEO_DIR));
app.use(express.urlencoded({ extended: true }));

// Define the HTML template for the gallery
const galleryTemplate = (media) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Media Gallery</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background-color: #f0f0f0;
            color: #333;
            margin: 0;
            padding: 0;
        }
        h1 {
            text-align: center;
            padding: 20px;
        }
        .gallery {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            justify-content: center;
            padding: 20px;
        }
        .gallery-item {
            position: relative;
            background-color: #fff;
            border-radius: 8px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            overflow: hidden;
            max-width: 300px;
            margin: 10px;
            display: flex;
            flex-direction: column;
            align-items: center;
            cursor: pointer;
        }
        .gallery-item img {
            display: block;
            width: 100%;
            height: auto;
            object-fit: cover;
        }
        .gallery-item video {
            display: block;
            width: 100%;
            height: auto;
            object-fit: cover;
        }
        .info {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            background: rgba(0, 0, 0, 0.6);
            color: white;
            padding: 10px;
            font-size: 14px;
            display: none;
            text-align: center;
        }
        .gallery-item:hover .info {
            display: block;
        }
        .download-button {
            display: block;
            margin: 10px;
            padding: 10px;
            background: #007bff;
            color: white;
            text-align: center;
            text-decoration: none;
            border-radius: 5px;
            width: calc(100% - 20px);
            font-size: 14px;
            box-sizing: border-box;
        }
        .download-button:hover {
            background: #0056b3;
        }
        .fullscreen {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.9);
            z-index: 1000;
            justify-content: center;
            align-items: center;
        }
        .fullscreen img {
            max-width: 90%;
            max-height: 90%;
        }
        .fullscreen video {
            max-width: 90%;
            max-height: 90%;
        }
        .fullscreen:target {
            display: flex;
        }
        .fullscreen-close {
            position: absolute;
            top: 20px;
            right: 20px;
            color: white;
            font-size: 24px;
            cursor: pointer;
        }
    </style>
</head>
<body>
    <h1>Media Gallery</h1>
    <div class="gallery">
        ${media.map(({ url, size, uploadDate }) => {
            const dateStr = uploadDate instanceof Date ? uploadDate.toDateString() : 'Unknown Date';
            const isVideo = url.endsWith('.mp4') || url.endsWith('.avi') || url.endsWith('.mov');
            const fileName = path.basename(url);
            return `
            <div class="gallery-item" onclick="openFullscreen('${fileName}')">
                ${isVideo ? 
                    `<video src="${url}" controls></video>` : 
                    `<img src="${url}" alt="Image" />`
                }
                <div class="info">Size: ${size} bytes<br>Uploaded: ${dateStr}</div>
                <a href="${url}" download class="download-button">Download</a>
            </div>
            <div id="fullscreen-${fileName}" class="fullscreen">
                <span class="fullscreen-close" onclick="closeFullscreen()">×</span>
                ${isVideo ? 
                    `<video src="${url}" controls autoplay></video>` : 
                    `<img src="${url}" alt="Fullscreen Image" />`
                }
            </div>
            `;
        }).join('')}
    </div>
    <script>
        function openFullscreen(fileName) {
            document.getElementById('fullscreen-' + fileName).style.display = 'flex';
        }

        function closeFullscreen() {
            document.querySelectorAll('.fullscreen').forEach(element => {
                element.style.display = 'none';
            });
        }
    </script>
</body>
</html>
`;

// Route to handle local video streaming with range requests
app.get('/local/:filename', (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(LOCAL_VIDEO_DIR, filename);
    
    fs.stat(filePath, (err, stats) => {
        if (err) {
            res.status(404).send('Not Found');
            return;
        }

        const fileSize = stats.size;
        const range = req.headers.range;
        
        if (range) {
            const [start, end] = range.replace(/bytes=/, "").split("-").map(Number);
            const chunkSize = (end - start) + 1;
            const fileStream = fs.createReadStream(filePath, { start, end });

            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunkSize,
                "Content-Type": "video/mp4"
            });

            fileStream.pipe(res);
        } else {
            res.writeHead(200, {
                "Content-Length": fileSize,
                "Content-Type": "video/mp4"
            });

            fs.createReadStream(filePath).pipe(res);
        }
    });
});

// Route to stream media files from SFTP
app.get('/media/:filename', async (req, res) => {
    const { filename } = req.params;
    let sftp;
    try {
        sftp = await createSFTPConnection();
        const remoteFilePath = path.join(SFTP_DIR, filename);
        const sftpStream = await sftp.get(remoteFilePath);

        if (Buffer.isBuffer(sftpStream)) {
            const stream = new PassThrough();
            stream.end(sftpStream);

            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
            stream.pipe(res);
        } else {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
            sftpStream.pipe(res);
        }

    } catch (error) {
        console.error(error);
        res.status(500).send('Error retrieving file.');
    } finally {
        if (sftp) {
            await sftp.end();
        }
    }
});

// Define the route to display the gallery
app.get('/', async (req, res) => {
    const media = await listMedia();
    res.send(galleryTemplate(media));
});

// Define the route for the upload page
app.get('/upload', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Upload Video</title>
    </head>
    <body>
        <h1>Upload Video</h1>
        <form action="/upload" method="post" enctype="multipart/form-data">
            <input type="file" name="video" accept="video/*" required>
            <button type="submit">Upload</button>
        </form>
    </body>
    </html>
    `);
});

// Define the route to handle video uploads
app.post('/upload', ipRestrict, upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    
    // Detect the file type and rename it with the correct extension
    const filePath = path.join(LOCAL_VIDEO_DIR, req.file.filename);
    const fileBuffer = fs.readFileSync(filePath);
    const mimeType = mime.lookup(req.file.originalname) || 'video/mp4'; // Default to mp4 if type cannot be detected
    const ext = mime.extension(mimeType) || 'mp4'; // Default to mp4 if extension cannot be detected
    const newFilePath = path.join(LOCAL_VIDEO_DIR, `${req.file.filename}.${ext}`);

    fs.renameSync(filePath, newFilePath);

    res.send('Upload successful.');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
