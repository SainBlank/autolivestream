const express = require('express');
const router = express.Router();
const os = require('os');
const { exec } = require('child_process');

function getDiskUsage() {
    return new Promise((resolve) => {
        exec('df -h /', (err, stdout) => {
            if (err) return resolve({ percent: 0, text: 'N/A' });
            const lines = stdout.trim().split('\n');
            const data = lines[1].split(/\s+/);
            resolve({
                total: data[1],
                used: data[2],
                percent: parseInt(data[4].replace('%', ''))
            });
        });
    });
}

let lastCpuUsage = process.cpuUsage();
let lastCpuTime = process.hrtime();

router.get('/stats', async (req, res) => {
    const memUsage = process.memoryUsage();
    const rss = memUsage.rss;
    const currentCpuUsage = process.cpuUsage();
    const currentCpuTime = process.hrtime();
    const elapTime = process.hrtime(lastCpuTime);
    const elapUsage = process.cpuUsage(lastCpuUsage);
    const elapTimeMS = elapTime[0] * 1000 + elapTime[1] / 1000000;
    const elapUserMS = elapUsage.user / 1000;
    const elapSystMS = elapUsage.system / 1000;
    const cpuSpentMS = (elapUsage.user + elapUsage.system) / 1000;
    const realTimeMS = elapTime[0] * 1000 + elapTime[1] / 1000000;
    let cpuPercent = (cpuSpentMS / realTimeMS) * 100;
    const cores = os.cpus().length;
    let systemCpuPercent = cpuPercent / cores;
    lastCpuUsage = currentCpuUsage;
    lastCpuTime = currentCpuTime;
    const usedMemGB = (rss / 1024 / 1024 / 1024).toFixed(2);
    const usedMemMB = (rss / 1024 / 1024).toFixed(0);
    const totalMemGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const memPercent = ((rss / os.totalmem()) * 100).toFixed(2);

    const disk = await getDiskUsage();

    res.json({
        ram: {
            total: totalMemGB + ' GB',
            used: usedMemGB + ' GB',
            usedMB: usedMemMB + ' MB',
            percent: parseFloat(memPercent)
        },
        cpu: {
            percent: parseFloat(systemCpuPercent.toFixed(2))
        },
        disk: disk
    });
});

router.get('/logs', (req, res) => {
    res.json(global.activityLogs.slice(-20).reverse());
});

module.exports = router;
