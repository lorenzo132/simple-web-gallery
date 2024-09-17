const express = require('express');
const multer = require('multer');
const SFTPClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const dotenv = require('dotenv');
const mime = require('mime-types'); // For detecting MIME types
const { Client } = require('nextcloud-node-client'); // For Nextcloud integration
const app = express();

// Load environment variables from .env file
dotenv.config();

// SFTP configuration from environment variables
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = process.env.SFTP_PORT || 22;
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const SFTP_DIR = process.env.SFTP_DIR || '/';

// Nextcloud configuration from environment variables
const NEXTCLOUD_HOST = process.env.NEXTCLOUD_HOST;
const NEXTCLOUD_USER = process.env.NEXTCLOUD_USER;
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD;
const NEXTCLOUD_DIR = process.env.NEXTCLOUD_DIR || '/';

// Allowed IP address for uploading and managing folders
const UPLOAD_ALLOWED_IP = process.env.UPLOAD_ALLOWED_IP;

// Local video storage directory
const LOCAL_VIDEO_DIR = 'local_videos/';

// Upload limit from environment variable (default to 700 MB)
const UPLOAD_LIMIT_MB = parseInt(process.env.UPLOAD_LIMIT_MB, 10) || 700;

// Configure multer to store files in a specific directory
const upload = multer({
    dest: LOCAL_VIDEO_DIR, // Directory to store uploaded files
    limits: { fileSize: UPLOAD_LIMIT_MB * 1024 * 1024 } // Limit file size to configured limit
});

// Ensure local video directory exists
if (!fs.existsSync(LOCAL_VIDEO_DIR)){
    fs.mkdirSync(LOCAL_VIDEO_DIR);
}

// Trust the X-Forwarded-For header to get the correct client IP if using a proxy
app.set('trust proxy', true);

// Middleware to check IP address for uploads and folder management
function ipRestrict(req, res, next) {
    const clientIp = req.ip;
    console.log(`Client IP: ${clientIp}`);
    
    if (clientIp === UPLOAD_ALLOWED_IP) {
        next();
    } else {
        res.status(403).send('Forbidden: You are not allowed to manage folders.');
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

// Function to create a Nextcloud client connection
function createNextcloudClient() {
    const client = new Client({
        url: NEXTCLOUD_HOST,
        username: NEXTCLOUD_USER,
        password: NEXTCLOUD_PASSWORD,
    });
    return client;
}

// Function to list media files from SFTP, local, and Nextcloud directories
async function listMedia(folder = '') {
    let sftp, nextcloudClient;
    const mediaItems = [];
    try {
        // List files from SFTP
        sftp = await createSFTPConnection();
        const sftpFileList = await sftp.list(path.join(SFTP_DIR, folder));

        for (const file of sftpFileList) {
            const ext = path.extname(file.name).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/media/${encodeURIComponent(file.name)}`;
                const fileStat = await sftp.stat(path.join(SFTP_DIR, folder, file.name));
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
        const localFileList = fs.readdirSync(path.join(LOCAL_VIDEO_DIR, folder));

        for (const file of localFileList) {
            const ext = path.extname(file).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/local/${encodeURIComponent(file)}`;
                const filePath = path.join(LOCAL_VIDEO_DIR, folder, file);
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

        // List files from Nextcloud
        nextcloudClient = createNextcloudClient();
        const nextcloudFileList = await nextcloudClient.getFolderContents(NEXTCLOUD_DIR + folder);

        for (const file of nextcloudFileList) {
            const ext = path.extname(file.name).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/nextcloud/${encodeURIComponent(file.name)}`;
                mediaItems.push({
                    url: fileUrl,
                    size: file.size,
                    uploadDate: file.lastModifiedDate || 'Unknown Date'
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

// Template for gallery page with folder management buttons
function galleryTemplate(media, showFolderButtons) {
    let html = `
        <h1>Media Gallery</h1>
        <div>
            ${media.map(item => `
                <div>
                    <a href="${item.url}">${item.url.split('/').pop()}</a>
                    <p>Size: ${item.size} bytes, Uploaded: ${item.uploadDate}</p>
                </div>
            `).join('')}
        </div>
    `;

    if (showFolderButtons) {
        html += `
            <h2>Manage Folders</h2>
            <form action="/create-folder" method="POST">
                <label for="folderName">New Folder Name:</label>
                <input type="text" id="folderName" name="folderName" required>
                <button type="submit">Create Folder</button>
            </form>
            <form action="/delete-folder" method="POST">
                <label for="folderName">Delete Folder Name:</label>
                <input type="text" id="folderName" name="folderName" required>
                <button type="submit">Delete Folder</button>
            </form>
        `;
    }

    return html;
}

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

// Route to list folders and media, showing folder management buttons only for allowed IPs
app.get('/', async (req, res) => {
    const clientIp = req.ip;
    const showFolderButtons = clientIp === UPLOAD_ALLOWED_IP;
    const media = await listMedia();
    res.send(galleryTemplate(media, showFolderButtons));
});

// Route to create new folders
app.post('/create-folder', ipRestrict, (req, res) => {
    const folderName = req.body.folderName;

    // Create folder locally
    const folderPath = path.join(LOCAL_VIDEO_DIR, folderName);
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath);
    }

    // Create folder in SFTP and Nextcloud if applicable
    (async () => {
        try {
            const sftp = await createSFTPConnection();
            await sftp.mkdir(path.join(SFTP_DIR, folderName));
            sftp.end();

            const nextcloudClient = createNextcloudClient();
            await nextcloudClient.createFolder(NEXTCLOUD_DIR + folderName);
        } catch (error) {
            console.error(error);
        }
    })();

    res.redirect('/');
});

// Route to delete folders
app.post('/delete-folder', ipRestrict, (req, res) => {
    const folderName = req.body.folderName;

    // Delete folder locally
    const folderPath = path.join(LOCAL_VIDEO_DIR, folderName);
    if (fs.existsSync(folderPath)) {
        fs.rmdirSync(folderPath, { recursive: true });
    }

    // Delete folder in SFTP and Nextcloud if applicable
    (async () => {
        try {
            const sftp = await createSFTPConnection();
            await sftp.rmdir(path.join(SFTP_DIR, folderName), true);
            sftp.end();

            const nextcloudClient = createNextcloudClient();
            await nextcloudClient.deleteFolder(NEXTCLOUD_DIR + folderName);
        } catch (error) {
            console.error(error);
        }
    })();

    res.redirect('/');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
