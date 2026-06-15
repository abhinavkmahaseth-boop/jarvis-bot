const functions = require('firebase-functions');
const axios = require('axios');

// Verify trade with Claude AI
exports.verifyTradeWithClaude = functions.https.onCall(async (data, context) => {
  const claudeApiKey = process.env.CLAUDE_API_KEY;

  if (!claudeApiKey) {
    return {
      success: false,
      error: 'Claude API key not configured in Firebase'
    };
  }

  try {
    const { prompt } = data;

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

    return {
      success: true,
      result: result
    };
  } catch (error) {
    console.error('Claude API error:', error);
    return {
      success: false,
      error: error.message || 'Failed to verify trade with Claude'
    };
  }
});
