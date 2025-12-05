// index.js
const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Use the environment variable or default to 'crowdsec_container'
const crowdsecContainer = process.env.CROWDSEC_CONTAINER || 'crowdsec_container';

app.use(cors());
app.use(express.json());

/**
 * GET /api/alerts
 * Executes "cscli alerts list", treats the output as an array,
 * sorts alerts descending by created_at, and returns the array.
 */
app.get('/api/alerts', (req, res) => {
  exec(`docker exec ${crowdsecContainer} cscli alerts list --output json`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error fetching alerts: ${error}`);
      return res.status(500).json({ error: 'Error fetching alerts' });
    }
    try {
      const alertArray = JSON.parse(stdout);
      // Assume alertArray is an array; sort descending by created_at
      alertArray.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      res.json(alertArray);
    } catch (parseError) {
      console.error('Error parsing alerts JSON:', parseError);
      res.status(500).json({ error: 'Error parsing alerts data' });
    }
  });
});

/**
 * GET /api/alerts/:id
 * Returns details for a single alert.
 */
app.get('/api/alerts/:id', (req, res) => {
  const alertId = req.params.id;
  exec(`docker exec ${crowdsecContainer} cscli alerts list --output json`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error fetching alerts: ${error}`);
      return res.status(500).json({ error: 'Error fetching alerts' });
    }
    try {
      const alertArray = JSON.parse(stdout);
      const alert = alertArray.find(a => String(a.id) === alertId);
      if (!alert) {
        return res.status(404).json({ error: 'Alert not found' });
      }
      res.json(alert);
    } catch (parseError) {
      console.error('Error parsing alerts JSON:', parseError);
      res.status(500).json({ error: 'Error parsing alerts data' });
    }
  });
});

/**
 * GET /api/decisions
 * Executes "cscli decisions list" which returns an array of parent objects.
 * Each parent object contains a "decisions" array with decision details.
 * For each decision, we map an object with:
 *  - id (from decision.id)
 *  - created_at (from decision.created_at or parent's created_at)
 *  - scenario (from decision.scenario, or "N/A" if missing)
 *  - value (from decision.value, or "N/A" if missing)
 *  - detail (the entire decision object)
 *
 * Then we combine all mapped decisions into one array, sort descending by created_at, and return it.
 */
app.get('/api/decisions', (req, res) => {
  exec(`docker exec ${crowdsecContainer} cscli decisions list --output json`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error fetching decisions: ${error}`);
      return res.status(500).json({ error: 'Error fetching decisions' });
    }
    try {
      const parentsArray = JSON.parse(stdout);
      let combinedDecisions = [];
      if (Array.isArray(parentsArray)) {
        parentsArray.forEach(parent => {
          if (Array.isArray(parent.decisions)) {
            const mapped = parent.decisions.map(decision => ({
              id: decision.id,
              created_at: decision.created_at || parent.created_at || null,
              scenario: decision.scenario || "N/A",
              value: decision.value || "N/A",
              detail: parent  // Entire decision object mapped to "detail"
            }));
            combinedDecisions = combinedDecisions.concat(mapped);
          }
        });
      }
      combinedDecisions.sort((a, b) => {
        const aTime = a.created_at ? new Date(a.created_at) : 0;
        const bTime = b.created_at ? new Date(b.created_at) : 0;
        return bTime - aTime;
      });
      res.json(combinedDecisions);
    } catch (parseError) {
      console.error('Error parsing decisions JSON:', parseError);
      res.status(500).json({ error: 'Error parsing decisions data' });
    }
  });
});

/**
 * DELETE /api/decisions/:id
 * Deletes a decision using the correct syntax.
 */
app.delete('/api/decisions/:id', (req, res) => {
  const decisionId = req.params.id;
  exec(`docker exec ${crowdsecContainer} cscli decisions delete --id ${decisionId}`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error deleting decision: ${error}`);
      return res.status(500).json({ error: 'Error deleting decision' });
    }
    res.json({ message: 'Decision deleted successfully', result: stdout });
  });
});

// Serve static files from the "public" directory.
// Serve static files from the "frontend/dist" directory.
app.use(express.static('frontend/dist'));

// Catch-all handler for any request that doesn't match an API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/dist/index.html'));
});

app.listen(port, () => console.log(`Server listening on port ${port}`));
