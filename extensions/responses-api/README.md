# Responses API (OpenClaw plugin)

This channel plugin provides an HTTP endpoint at `/v1/channel/responses` that implements the OpenAI Responses API protocol. Requests are authenticated via bearer tokens and routed to specific agents based on the token used.

## Configuration

Add a `responses-api` section to your `channels` configuration in `openclaw.json`:

```json
{
  "channels": {
    "responses-api": {
      "tokens": {
        "sk-your-token-here": {
          "agentId": "main",
          "label": "Production API Key"
        },
        "sk-another-token": {
          "agentId": "secondary",
          "label": "Development API Key"
        }
      }
    }
  },
  "plugins": {
    "entries": {
      "responses-api": {
        "enabled": true
      }
    }
  }
}
```

### Token Configuration

Each token in the `tokens` object maps to a specific agent:

| Property  | Type   | Required | Description                         |
| --------- | ------ | -------- | ----------------------------------- |
| `agentId` | string | Yes      | The agent ID to route requests to   |
| `label`   | string | No       | Human-readable label for this token |

## Usage

Send requests to the gateway with your token:

```bash
curl -X POST http://localhost:18789/v1/channel/responses \
  -H "Authorization: Bearer sk-your-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openclaw",
    "input": "Hello, how are you?"
  }'
```

### Streaming Responses

Set `stream: true` for Server-Sent Events:

```bash
curl -X POST http://localhost:18789/v1/channel/responses \
  -H "Authorization: Bearer sk-your-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "Tell me a story"
  }'
```

### Continuing Conversations

Use `previous_response_id` to continue a conversation:

```bash
# First request
RESPONSE=$(curl -s -X POST http://localhost:18789/v1/channel/responses \
  -H "Authorization: Bearer sk-your-token-here" \
  -H "Content-Type: application/json" \
  -d '{"model": "openclaw", "input": "Hello"}' | jq -r '.id')

# Follow-up using previous_response_id
curl -X POST http://localhost:18789/v1/channel/responses \
  -H "Authorization: Bearer sk-your-token-here" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"openclaw\",
    \"previous_response_id\": \"$RESPONSE\",
    \"input\": \"Tell me more about that\"
  }"
```

## Request Format

The endpoint accepts standard OpenAI Responses API requests:

```typescript
{
  model: string;           // Ignored (agent determined by token)
  input: string | Array<{ // User message(s)
    role: "user" | "system";
    content: string | Array<{
      type: "input_text" | "input_image" | "input_file";
      // ... content fields
    }>;
  }>;
  instructions?: string;   // Additional system prompt
  stream?: boolean;        // Enable streaming
  previous_response_id?: string; // Continue conversation
  user?: string;          // User identifier
}
```

## Security

- Each token can only access its configured agent
- Session mappings are persisted to survive gateway restarts

## Response Format

Responses follow the OpenAI Responses API specification:

```json
{
  "id": "resp_xxx",
  "object": "response",
  "status": "completed",
  "model": "openclaw",
  "output": [
    {
      "type": "message",
      "id": "msg_xxx",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "Hello! How can I help you today?"
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20,
    "total_tokens": 30
  }
}
```
