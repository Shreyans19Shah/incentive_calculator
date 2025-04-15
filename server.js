const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const { Octokit } = require('@octokit/rest');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Initialize Octokit for GitHub API
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Admin credentials
const ADMIN_CREDENTIALS = {
    username: 'Admin',
    password: '$2b$10$YDun1n93NNqBf1lf5AeoG.vWX.fp3KppLKXx5zqQX6AaRBRXWksJG' // Hashed 'PESB@14'
};

// Multer setup for file uploads
const upload = multer({ dest: 'Uploads/' });

// Middleware to verify JWT
function verifyToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        req.user = decoded;
        next();
    });
}

// Login endpoint
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    if (username !== ADMIN_CREDENTIALS.username) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    try {
        const match = await bcrypt.compare(password, ADMIN_CREDENTIALS.password);
        if (!match) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Upload endpoint
app.post('/upload', verifyToken, upload.fields([
    { name: 'trailIncomeFile', maxCount: 1 },
    { name: 'newBusinessFile', maxCount: 1 }
]), async (req, res) => {
    try {
        const trailFile = req.files['trailIncomeFile']?.[0];
        const newBusinessFile = req.files['newBusinessFile']?.[0];
        if (!trailFile || !newBusinessFile) {
            throw new Error('Both files are required');
        }

        const currentMonth = new Date().toISOString().slice(0, 7);
        console.log('Current Month:', currentMonth);

        const trailWorkbook = XLSX.readFile(trailFile.path);
        const trailSheetName = trailWorkbook.SheetNames[0];
        const trailWorksheet = trailWorkbook.Sheets[trailSheetName];
        const trailData = XLSX.utils.sheet_to_json(trailWorksheet);
        console.log('Trail Income Data:', trailData);

        const newBusinessWorkbook = XLSX.readFile(newBusinessFile.path);
        const newBusinessSheetName = newBusinessWorkbook.SheetNames[0];
        const newBusinessWorksheet = newBusinessWorkbook.Sheets[newBusinessSheetName];
        const newBusinessData = XLSX.utils.sheet_to_json(newBusinessWorksheet);
        console.log('New Business Data:', newBusinessData);

        const slabFilePath = path.join(__dirname, 'slabs.xlsx');
        console.log('Checking for slabs.xlsx at:', slabFilePath);
        if (!fs.existsSync(slabFilePath)) {
            console.error('slabs.xlsx not found at:', slabFilePath);
            throw new Error('slabs.xlsx not found in project root');
        }

        let slabData = [];
        try {
            const slabWorkbook = XLSX.readFile(slabFilePath);
            const slabSheetName = slabWorkbook.SheetNames[0];
            const slabWorksheet = slabWorkbook.Sheets[slabSheetName];
            slabData = XLSX.utils.sheet_to_json(slabWorksheet);
            if (!slabData.length) {
                throw new Error('slabs.xlsx is empty');
            }
            console.log('Slab Data:', slabData);
        } catch (error) {
            console.error('Error reading slabs.xlsx:', error.message);
            throw new Error('Failed to read slabs.xlsx: ' + error.message);
        }

        let masterData = [];
        try {
            const response = await octokit.repos.getContent({
                owner: process.env.GITHUB_OWNER,
                repo: process.env.GITHUB_REPO,
                path: 'app/trail-data/master_trail_income.xlsx'
            });
            const content = Buffer.from(response.data.content, 'base64');
            const masterWorkbook = XLSX.read(content, { type: 'buffer' });
            const masterSheetName = masterWorkbook.SheetNames[0];
            masterData = XLSX.utils.sheet_to_json(masterWorkbook.Sheets[masterSheetName]);
            console.log('Read master_trail_income.xlsx from GitHub');
        } catch (error) {
            if (error.status === 404) {
                console.log('master_trail_income.xlsx not found. Will create it.');
            } else {
                console.error('Error reading from GitHub:', error.message);
                throw new Error('Failed to read master trail income data');
            }
        }

        const outputData = trailData.map(trailEntry => {
            const name = trailEntry['Name']?.trim();
            if (!name) return null;

            const trailIncome = trailEntry['Trail Income'] || 0;
            const newBusinessEntry = newBusinessData.find(row => row['Name']?.trim() === name);
            const newBusiness = newBusinessEntry ? (newBusinessEntry['New Business'] || 0) : 0;
            const slabEntry = slabData.find(row => row['Name']?.trim() === name);
            const slab = slabEntry ? (slabEntry['Slab'] || 0) : 0;

            const pastEntries = masterData.filter(row => row.Name === name);
            const previousHigh = pastEntries.length > 0
                ? Math.max(...pastEntries.map(row => row['Trail Income'] || 0))
                : 0;

            const newBusinessValue = trailIncome > previousHigh ? trailIncome - previousHigh : 0;
            let incentive = 0;
            let remarks = '';

            if (trailIncome > previousHigh && newBusiness > slab) {
                incentive = newBusinessValue * 0.20;
                remarks = 'Incentive given';
            } else if (trailIncome <= previousHigh) {
                remarks = 'Trail Income does not exceed Previous High';
            } else {
                remarks = 'New Business does not exceed Slab Amount';
            }

            const part1 = incentive * 0.70;
            const part2 = incentive * 0.30;

            return {
                Name: name,
                'Incentive Amount': incentive,
                Remarks: remarks,
                'Part 1 (70%)': part1,
                'Part 2 (30%)': part2
            };
        }).filter(row => row);

        const newEntries = trailData.map(row => ({
            Name: row['Name']?.trim(),
            'Trail Income': row['Trail Income'] || 0,
            Month: currentMonth
        }));

        masterData.push(...newEntries);
        const masterWorkbook = XLSX.utils.book_new();
        const masterWorksheet = XLSX.utils.json_to_sheet(masterData);
        XLSX.utils.book_append_sheet(masterWorkbook, masterWorksheet, 'TrailIncome');
        const buffer = XLSX.write(masterWorkbook, { type: 'buffer' });
        const content = buffer.toString('base64');

        const commitMessage = `Update master_trail_income.xlsx for ${currentMonth}`;
        let sha;
        try {
            const existing = await octokit.repos.getContent({
                owner: process.env.GITHUB_OWNER,
                repo: process.env.GITHUB_REPO,
                path: 'app/trail-data/master_trail_income.xlsx'
            });
            sha = existing.data.sha;
        } catch (err) {
            if (err.status !== 404) throw err;
        }

        await octokit.repos.createOrUpdateFileContents({
            owner: process.env.GITHUB_OWNER,
            repo: process.env.GITHUB_REPO,
            path: 'app/trail-data/master_trail_income.xlsx',
            message: commitMessage,
            content,
            sha
        });

        const uploadsDir = path.join(__dirname, 'Uploads');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }

        const outputWorkbook = XLSX.utils.book_new();
        const outputWorksheet = XLSX.utils.json_to_sheet(outputData);
        XLSX.utils.book_append_sheet(outputWorkbook, outputWorksheet, 'Incentives');
        const outputPath = path.join(uploadsDir, 'incentive_output.xlsx');
        XLSX.writeFile(outputWorkbook, outputPath);

        res.download(outputPath, 'incentive_output.xlsx', err => {
            if (err) {
                console.error('Download error:', err);
                res.status(500).json({ error: 'Failed to download file' });
            }
        });
    } catch (error) {
        console.error('Upload error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
