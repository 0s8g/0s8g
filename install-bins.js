// Runs after npm install via "postinstall" script.
// Writes bin-paths.json so index.js knows where ffmpeg and yt-dlp are,
// regardless of whether system binaries exist.

const fs   = require('fs');
const path = require('path');

const paths = {};

// ffmpeg-static ships a real ffmpeg binary inside node_modules
try {
    paths.ffmpeg = require('ffmpeg-static');
    console.log('[bins] ffmpeg:', paths.ffmpeg);
} catch {
    paths.ffmpeg = 'ffmpeg'; // fallback to system
    console.log('[bins] ffmpeg-static not found, using system ffmpeg');
}

// yt-dlp-exec ships a yt-dlp binary inside node_modules
try {
    paths.ytdlp = require('yt-dlp-exec').getBinaryPath?.() 
               ?? require.resolve('yt-dlp-exec/node_modules/.bin/yt-dlp');
    console.log('[bins] yt-dlp:', paths.ytdlp);
} catch {
    // yt-dlp-exec exposes the binary path differently depending on version
    try {
        const ytdlpPkg = require('yt-dlp-exec');
        paths.ytdlp = typeof ytdlpPkg === 'string' ? ytdlpPkg : 'yt-dlp';
    } catch {
        paths.ytdlp = 'yt-dlp';
    }
    console.log('[bins] yt-dlp path:', paths.ytdlp);
}

fs.writeFileSync(
    path.join(__dirname, 'bin-paths.json'),
    JSON.stringify(paths, null, 2)
);
console.log('[bins] bin-paths.json written ✓');
