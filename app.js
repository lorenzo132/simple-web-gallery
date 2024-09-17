const express = require('express');
const multer = require('multer');
const SFTPClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const mime = require('mime-types'); // For detecting MIME types
const app = express();

// Load environment variables from .env file
dotenv.config();

// SFTP configuration from environment variables
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = process.env.SFTP_PORT || 22;
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const SFTP_DIR = process.env.SFTP_DIR || '/';

// Allowed IP address for uploading videos and creating folders
const ALLOWED_IP = process.env.UPLOAD_ALLOWED_IP;

// Local video storage directory
const LOCAL_MEDIA_DIR = 'local_media/';

// Upload limit from environment variable (default to 700 MB)
const UPLOAD_LIMIT_MB = parseInt(process.env.UPLOAD_LIMIT_MB, 10) || 700;

// Configure multer to store files in a specific directory
const upload = multer({
    dest: LOCAL_MEDIA_DIR, // Directory to store uploaded files
    limits: { fileSize: UPLOAD_LIMIT_MB * 1024 * 1024 } // Limit file size to configured limit
});

// Ensure local media directory exists
if (!fs.existsSync(LOCAL_MEDIA_DIR)) {
    fs.mkdirSync(LOCAL_MEDIA_DIR);
}

// Trust the X-Forwarded-For header to get the correct client IP if using a proxy
app.set('trust proxy', true);

// Middleware to check IP address for uploads and folder creation
function ipRestrict(req, res, next) {
    const clientIp = req.ip;
    if (clientIp === ALLOWED_IP) {
        next();
    } else {
        res.status(403).send('Forbidden: You are not allowed to perform this action.');
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
        const localFileList = fs.readdirSync(LOCAL_MEDIA_DIR);

        for (const file of localFileList) {
            const ext = path.extname(file).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/local/${encodeURIComponent(file)}`;
                const filePath = path.join(LOCAL_MEDIA_DIR, file);
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
app.use('/local', express.static(LOCAL_MEDIA_DIR));
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
        .gallery-item img, .gallery-item video {
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
        .fullscreen img, .fullscreen video {
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
    <form action="/create-folder" method="post" id="create-folder-form">
        <input type="text" name="folderName" placeholder="New Folder Name" required>
        <button type="submit">Create Folder</button>
    </form>
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
                    `<img src="${url}" alt="Image" />`
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

// Route to display the gallery
app.get('/', async (req, res) => {
    const media = await listMedia();
    res.send(galleryTemplate(media));
});

// Route to handle video uploads
app.post('/upload', ipRestrict, upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    res.send('File uploaded successfully.');
});

// Route to handle folder creation
app.post('/create-folder', ipRestrict, (req, res) => {
    const { folderName } = req.body;
    if (!folderName) {
        return res.status(400).send('Folder name is required.');
    }

    const folderPath = path.join(LOCAL_MEDIA_DIR, folderName);

    // Check if folder already exists
    if (fs.existsSync(folderPath)) {
        return res.status(400).send('Folder already exists.');
    }

    // Create the new folder
    fs.mkdir(folderPath, (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error creating folder.');
        }

        res.send('Folder created successfully.');
    });
});

// Route to serve media files from local directory
app.use('/local', express.static(LOCAL_MEDIA_DIR));

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
