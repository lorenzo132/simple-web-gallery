const express = require('express');
const SFTPClient = require('ssh2-sftp-client');
const path = require('path');
const { PassThrough } = require('stream');
const dotenv = require('dotenv');
const app = express();

// Load environment variables from .env file
dotenv.config();

// SFTP configuration from environment variables
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = process.env.SFTP_PORT || 22;
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const SFTP_DIR = process.env.SFTP_DIR || '/';

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

// Function to list media files
async function listMedia() {
    let sftp;
    try {
        sftp = await createSFTPConnection();
        const fileList = await sftp.list(SFTP_DIR);
        const mediaItems = [];

        for (const file of fileList) {
            const ext = path.extname(file.name).toLowerCase();
            // Added .webp as a supported image format
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.avi', '.mov'].includes(ext)) {
                const fileUrl = `/media/${encodeURIComponent(file.name)}`; // URL for media route
                const fileStat = await sftp.stat(path.join(SFTP_DIR, file.name));

                // Handle the modification time (mtime) properly
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

        // Sort by upload date (most recent first)
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
            width: calc(100% - 20px); /* Adjust width to fit within the gallery item */
            font-size: 14px;
            box-sizing: border-box;
        }
        .download-button:hover {
            background: #0056b3;
        }
    </style>
</head>
<body>
    <h1>Media Gallery</h1>
    <div class="gallery">
        ${media.map(({ url, size, uploadDate }) => {
            const dateStr = uploadDate instanceof Date ? uploadDate.toDateString() : 'Unknown Date';
            const isVideo = url.endsWith('.mp4') || url.endsWith('.avi') || url.endsWith('.mov');
            return `
            <div class="gallery-item">
                ${isVideo ? 
                    `<video src="${url}" controls></video>` : 
                    `<img src="${url}" alt="Image" />`
                }
                <div class="info">Size: ${size} bytes<br>Uploaded: ${dateStr}</div>
                <a href="${url}" download class="download-button">Download</a>
            </div>
            `;
        }).join('')}
    </div>
</body>
</html>
`;

// Route to stream media files
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

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
