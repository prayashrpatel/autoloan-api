module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid JSON' });
    return res.status(200).json({ decision: 'PENDING', received: body });
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
};
