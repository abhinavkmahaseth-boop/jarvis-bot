import axios from 'axios';

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const claudeApiKey = process.env.CLAUDE_API_KEY;

  if (!claudeApiKey) {
    return res.status(500).json({
      success: false,
      error: 'Claude API key not configured'
    });
  }

  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: 'Prompt is required'
      });
    }

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      },
      {
        headers: {
          'x-api-key': claudeApiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        }
      }
    );

    const result = response.data.content[0].text.trim();

    return res.status(200).json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error('Claude API error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to verify trade'
    });
  }
}
