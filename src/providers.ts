/**
 * Extra built-in provider catalog for the Keys Manager.
 *
 * Every entry is an OpenAI-compatible / Anthropic-compatible endpoint that
 * the shipped DSH pi-ai directory does not already declare. The seed model
 * rows are a fallback for environments where endpoint discovery is blocked;
 * when discovery succeeds the Host installs the discovered catalog instead.
 *
 * Metadata was curated from oh-my-pi's provider catalog
 * (packages/catalog/src/models.json and compat/rules/providers/*.kdl,
 * MIT). Keep ids stable: a route id is a settings key, a credential
 * reference stem, and a model-picker identity.
 */
import type { ExtraProvider } from './domain.js'

/** Curated seed catalog, checked against the shared domain type. */
export const EXTRA_PROVIDERS: readonly ExtraProvider[] = Object.freeze([
  {
    "id": "deepinfra",
    "name": "DeepInfra",
    "api": "openai-completions",
    "baseURL": "https://api.deepinfra.com/v1/openai",
    "env": [
      "DEEPINFRA_API_KEY"
    ],
    "models": [
      {
        "id": "anthropic/claude-fable-5",
        "name": "Claude Fable 5",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "anthropic/claude-haiku-4-5",
        "name": "Claude Haiku 4.5",
        "contextWindow": 200000,
        "maxTokens": 64000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash",
        "name": "DeepSeek V4.1 Flash",
        "contextWindow": 1048576,
        "maxTokens": 384000,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "novita",
    "name": "Novita",
    "api": "openai-completions",
    "baseURL": "https://api.novita.ai/openai/v1",
    "env": [
      "NOVITA_API_KEY"
    ],
    "models": [
      {
        "id": "deepseek/deepseek_v3",
        "name": "DeepSeek V3",
        "contextWindow": 64000,
        "maxTokens": 16000,
        "input": [
          "text"
        ]
      },
      {
        "id": "zai-org/glm-5",
        "name": "GLM 5",
        "contextWindow": 202800,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      },
      {
        "id": "moonshotai/kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "contextWindow": 262144,
        "maxTokens": 262144,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "stepfun",
    "name": "StepFun",
    "api": "openai-completions",
    "baseURL": "https://api.stepfun.ai/v1",
    "env": [
      "STEPFUN_API_KEY"
    ],
    "models": [
      {
        "id": "step-3.5-flash",
        "name": "Step 3.5 Flash",
        "contextWindow": 256000,
        "maxTokens": 256000,
        "input": [
          "text"
        ]
      },
      {
        "id": "step-3.7-flash",
        "name": "Step 3.7 Flash",
        "contextWindow": 256000,
        "maxTokens": 256000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "step-5-preview",
        "name": "Step 5 Preview",
        "contextWindow": 1000000,
        "maxTokens": 1000000,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "sambanova",
    "name": "SambaNova",
    "api": "openai-completions",
    "baseURL": "https://api.sambanova.ai/v1",
    "env": [
      "SAMBANOVA_API_KEY"
    ],
    "models": [
      {
        "id": "gpt-oss-120b",
        "name": "GPT OSS 120B",
        "contextWindow": 131072,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "qianfan",
    "name": "Qianfan",
    "api": "openai-completions",
    "baseURL": "https://qianfan.baidubce.com/v2",
    "env": [
      "QIANFAN_API_KEY"
    ],
    "models": [
      {
        "id": "deepseek-v3.2",
        "name": "DeepSeek V3.2",
        "contextWindow": 98304,
        "maxTokens": 32768,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "gmi-cloud",
    "name": "GMI Cloud",
    "api": "openai-completions",
    "baseURL": "https://api.gmi-serving.com/v1",
    "env": [
      "GMI_API_KEY"
    ],
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash",
        "name": "DeepSeek V4 Flash",
        "contextWindow": 1048576,
        "maxTokens": 384000,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "synthetic",
    "name": "Synthetic",
    "api": "openai-completions",
    "baseURL": "https://api.synthetic.new/openai/v1",
    "env": [
      "SYNTHETIC_API_KEY"
    ],
    "models": [
      {
        "id": "hf:deepseek-ai/DeepSeek-V4.1-Flash",
        "name": "DeepSeek V4.1 Flash",
        "contextWindow": 524288,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "hf:moonshotai/Kimi-K3",
        "name": "Kimi K3",
        "contextWindow": 524288,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
        "name": "Nemotron 3 Super 120B",
        "contextWindow": 262144,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      },
      {
        "id": "hf:openai/gpt-oss-120b",
        "name": "GPT OSS 120B",
        "contextWindow": 131072,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "zenmux",
    "name": "ZenMux",
    "api": "openai-completions",
    "baseURL": "https://zenmux.ai/api/v1",
    "env": [
      "ZENMUX_API_KEY"
    ],
    "models": [
      {
        "id": "baidu/ernie-5.1",
        "name": "ERNIE 5.1",
        "contextWindow": 128000,
        "input": [
          "text"
        ]
      },
      {
        "id": "anthropic/claude-opus-5",
        "name": "Claude Opus 5",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "openai/gpt-5.5",
        "name": "GPT-5.5",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "kilo",
    "name": "Kilo Gateway",
    "api": "openai-completions",
    "baseURL": "https://api.kilo.ai/api/gateway",
    "env": [
      "KILO_API_KEY"
    ],
    "models": [
      {
        "id": "anthropic/claude-opus-4.7",
        "name": "Claude Opus 4.7",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "deepseek/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "contextWindow": 1024000,
        "maxTokens": 384000,
        "input": [
          "text"
        ]
      },
      {
        "id": "openai/gpt-5.5",
        "name": "GPT-5.5",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "nanogpt",
    "name": "NanoGPT",
    "api": "openai-completions",
    "baseURL": "https://nano-gpt.com/api/v1",
    "env": [
      "NANO_GPT_API_KEY"
    ],
    "models": [
      {
        "id": "moonshotai/kimi-k3",
        "name": "Kimi K3",
        "contextWindow": 1048576,
        "maxTokens": 943718,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "zai-org/glm-5",
        "name": "GLM 5",
        "contextWindow": 200000,
        "maxTokens": 128000,
        "input": [
          "text"
        ]
      },
      {
        "id": "openai/gpt-5.5",
        "name": "GPT 5.5",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "venice",
    "name": "Venice AI",
    "api": "openai-completions",
    "baseURL": "https://api.venice.ai/api/v1",
    "env": [
      "VENICE_API_KEY"
    ],
    "models": [
      {
        "id": "aion-labs-aion-3-5",
        "name": "Aion 3.5",
        "contextWindow": 262144,
        "maxTokens": 32768,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "aimlapi",
    "name": "AIML API",
    "api": "openai-completions",
    "baseURL": "https://api.aimlapi.com/v1",
    "env": [
      "AIMLAPI_API_KEY"
    ],
    "models": [
      {
        "id": "alibaba/qwen3-235b-a22b-thinking-2507",
        "name": "Qwen3 235B Thinking",
        "contextWindow": 128000,
        "maxTokens": 8192,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "aiand",
    "name": "AI&",
    "api": "openai-completions",
    "baseURL": "https://api.aiand.com/v1",
    "env": [
      "AIAND_API_KEY"
    ],
    "models": [
      {
        "id": "deepseek-ai/deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "contextWindow": 1048576,
        "maxTokens": 393216,
        "input": [
          "text"
        ]
      },
      {
        "id": "deepseek-ai/deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "contextWindow": 1048576,
        "maxTokens": 384000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "moonshotai/kimi-k3",
        "name": "Kimi K3",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "google/gemma-4-31b-it",
        "name": "Gemma 4 31B",
        "contextWindow": 262144,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "helmcode",
    "name": "Helmcode",
    "api": "openai-completions",
    "baseURL": "https://api.helmcode.com/v1",
    "env": [
      "HELMCODE_API_KEY"
    ],
    "models": [
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "contextWindow": 1000000,
        "input": [
          "text"
        ]
      },
      {
        "id": "glm5.3",
        "name": "GLM 5.3",
        "contextWindow": 1000000,
        "input": [
          "text"
        ]
      },
      {
        "id": "qwen3.6",
        "name": "Qwen3.6",
        "contextWindow": 262144,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "gemma4",
        "name": "Gemma 4",
        "contextWindow": 262144,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "alibaba-coding-plan",
    "name": "Alibaba Coding Plan",
    "api": "openai-completions",
    "baseURL": "https://coding-intl.dashscope.aliyuncs.com/v1",
    "env": [
      "ALIBABA_CODING_PLAN_API_KEY"
    ],
    "models": [
      {
        "id": "qwen3-coder-plus",
        "name": "Qwen3 Coder Plus",
        "contextWindow": 1000000,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      },
      {
        "id": "glm-5",
        "name": "GLM-5",
        "contextWindow": 202752,
        "maxTokens": 16384,
        "input": [
          "text"
        ]
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5",
        "contextWindow": 262144,
        "maxTokens": 32768,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax-M2.5",
        "contextWindow": 196608,
        "maxTokens": 24576,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "minimax-code",
    "name": "MiniMax Coding (Global)",
    "api": "anthropic-messages",
    "baseURL": "https://api.minimax.io/anthropic",
    "env": [
      "MINIMAX_CODE_API_KEY"
    ],
    "models": [
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax-M2.7",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax-M2.5",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      },
      {
        "id": "MiniMax-M2.1",
        "name": "MiniMax-M2.1",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "minimax-code-cn",
    "name": "MiniMax Coding (CN)",
    "api": "anthropic-messages",
    "baseURL": "https://api.minimaxi.com/anthropic",
    "env": [
      "MINIMAX_CODE_CN_API_KEY"
    ],
    "models": [
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax-M2.7",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax-M2.5",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      },
      {
        "id": "MiniMax-M2.1",
        "name": "MiniMax-M2.1",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "umans",
    "name": "Umans AI Coding Plan",
    "api": "anthropic-messages",
    "baseURL": "https://api.code.umans.ai",
    "env": [
      "UMANS_AI_CODING_PLAN_API_KEY"
    ],
    "models": [
      {
        "id": "umans-coder",
        "name": "Umans Coder",
        "contextWindow": 1048576,
        "maxTokens": 131071,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "umans-glm-5.3",
        "name": "Umans GLM 5.3",
        "contextWindow": 1048576,
        "maxTokens": 131071,
        "input": [
          "text"
        ]
      },
      {
        "id": "umans-flash",
        "name": "Umans Flash",
        "contextWindow": 262144,
        "maxTokens": 32768,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "sakana",
    "name": "Sakana AI",
    "api": "openai-responses",
    "baseURL": "https://api.sakana.ai/v1",
    "env": [
      "SAKANA_API_KEY"
    ],
    "models": [
      {
        "id": "fugu-ultra",
        "name": "Fugu Ultra",
        "contextWindow": 1000000,
        "input": [
          "text"
        ]
      },
      {
        "id": "fugu",
        "name": "Fugu",
        "contextWindow": 1000000,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "coralbricks",
    "name": "CoralBricks",
    "api": "openai-completions",
    "baseURL": "https://inference.coralbricks.ai/v1",
    "env": [
      "CORAL_API_KEY"
    ],
    "models": [
      {
        "id": "deepseek-v4.1-flash-fast",
        "name": "DeepSeek V4.1 Flash",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "glm-5.3-fast",
        "name": "GLM 5.3",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "wafer-serverless",
    "name": "Wafer Serverless",
    "api": "openai-completions",
    "baseURL": "https://pass.wafer.ai/v1",
    "env": [
      "WAFER_SERVERLESS_API_KEY"
    ],
    "models": [
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "contextWindow": 1000000,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "contextWindow": 1000000,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      },
      {
        "id": "DeepSeek-V4.1-Flash",
        "name": "DeepSeek V4.1 Flash",
        "contextWindow": 1048576,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "alibaba-token-plan",
    "name": "Alibaba Token Plan",
    "api": "openai-completions",
    "baseURL": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "env": [
      "ALIBABA_TOKEN_PLAN_API_KEY",
      "BAILIAN_TOKEN_PLAN_API_KEY"
    ],
    "models": [
      {
        "id": "qwen3.8-max",
        "name": "Qwen3.8 Max",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "input": [
          "text"
        ]
      },
      {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "charm-hyper",
    "name": "Charm Hyper",
    "api": "openai-completions",
    "baseURL": "https://hyper.charm.land/v1",
    "env": [
      "CHARM_HYPER_API_KEY",
      "HYPER_API_KEY"
    ],
    "models": [
      {
        "id": "prism",
        "name": "Prism",
        "contextWindow": 1000000,
        "maxTokens": 16000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "contextWindow": 1048576,
        "maxTokens": 262144,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "glm-5.3",
        "name": "GLM 5.3",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "input": [
          "text"
        ]
      },
      {
        "id": "qwen3.8-max",
        "name": "Qwen3.8-Max",
        "contextWindow": 1000000,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "litellm",
    "name": "LiteLLM Proxy",
    "api": "openai-completions",
    "baseURL": "http://localhost:4000/v1",
    "env": [
      "LITELLM_API_KEY"
    ],
    "models": [
      {
        "id": "openai/gpt-4o",
        "name": "GPT-4o",
        "contextWindow": 128000,
        "maxTokens": 16384,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "anthropic/claude-sonnet-4-20250514",
        "name": "Claude Sonnet 4",
        "contextWindow": 200000,
        "maxTokens": 64000,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "siliconflow",
    "name": "SiliconFlow",
    "api": "openai-completions",
    "baseURL": "https://api.siliconflow.com/v1",
    "env": [
      "SILICONFLOW_API_KEY"
    ],
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash",
        "name": "DeepSeek V4 Flash",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "input": [
          "text"
        ]
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro",
        "name": "DeepSeek V4 Pro",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "input": [
          "text"
        ]
      },
      {
        "id": "zai-org/GLM-5.2",
        "name": "GLM-5.2",
        "contextWindow": 1049000,
        "maxTokens": 262000,
        "input": [
          "text"
        ]
      },
      {
        "id": "moonshotai/Kimi-K3",
        "name": "Kimi K3",
        "contextWindow": 1048576,
        "maxTokens": 262000,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "siliconflow-cn",
    "name": "SiliconFlow (CN)",
    "api": "openai-completions",
    "baseURL": "https://api.siliconflow.cn/v1",
    "env": [
      "SILICONFLOW_CN_API_KEY"
    ],
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro",
        "name": "DeepSeek V4 Pro",
        "contextWindow": 1049000,
        "maxTokens": 393000,
        "input": [
          "text"
        ]
      },
      {
        "id": "zai-org/GLM-5.2",
        "name": "GLM-5.2",
        "contextWindow": 1049000,
        "maxTokens": 262000,
        "input": [
          "text"
        ]
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash",
        "name": "DeepSeek V4 Flash",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "zhipu-coding-plan",
    "name": "Zhipu Coding Plan",
    "api": "openai-completions",
    "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "models": [
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      },
      {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      },
      {
        "id": "glm-4.7",
        "name": "GLM-4.7",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "abliteration",
    "name": "Abliteration",
    "api": "openai-responses",
    "baseURL": "https://api.abliteration.ai/v1",
    "env": [
      "ABLITERATION_API_KEY",
      "ABLIT_KEY"
    ],
    "models": [
      {
        "id": "abliterated-model",
        "name": "Abliterated Model",
        "contextWindow": 262144,
        "maxTokens": 262134,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "abliterated-model-large",
        "name": "Abliterated Model Large",
        "contextWindow": 1000000,
        "maxTokens": 999990,
        "input": [
          "text"
        ]
      },
      {
        "id": "abliterated-model-large-v2",
        "name": "Abliterated Model Large V2",
        "contextWindow": 1000000,
        "maxTokens": 999990,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "cline-pass",
    "name": "ClinePass",
    "api": "openai-completions",
    "baseURL": "https://api.cline.bot/api/v1",
    "env": [
      "CLINE_API_KEY"
    ],
    "models": [
      {
        "id": "cline-free/mimo-v2.6-flash",
        "name": "MiMo-V2.6-Flash (free)",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "contextWindow": 1048576,
        "maxTokens": 1048576,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "contextWindow": 1048576,
        "maxTokens": 384000,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "commandcode",
    "name": "Command Code",
    "api": "openai-completions",
    "baseURL": "https://api.commandcode.ai/provider/v1",
    "env": [
      "COMMAND_CODE_API_KEY",
      "COMMANDCODE_API_KEY"
    ],
    "models": [
      {
        "id": "Qwen/Qwen3.8-Max",
        "name": "Qwen 3.8 Max",
        "contextWindow": 1000000,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "moonshotai/Kimi-K2.7-Code",
        "name": "Kimi K2.7 Code",
        "contextWindow": 256000,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "z-ai/glm-5.3-flash",
        "name": "GLM-5.3 Flash",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "deepseek/deepseek-v4-flash-fast",
        "name": "DeepSeek V4 Flash Fast",
        "contextWindow": 1000000,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      }
    ]
  },
  {
    "id": "firepass",
    "name": "Fire Pass",
    "api": "openai-completions",
    "baseURL": "https://api.fireworks.ai/inference/v1",
    "env": [
      "FIREPASS_API_KEY"
    ],
    "models": [
      {
        "id": "glm-5.2-fast",
        "name": "GLM 5.2 Fast (Fire Pass)",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": [
          "text"
        ]
      },
      {
        "id": "kimi-k3-fast",
        "name": "Kimi K3 Fast (Fire Pass)",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  },
  {
    "id": "yolo-auto",
    "name": "Yolo Auto",
    "api": "openai-completions",
    "baseURL": "https://yolo-auto.com/v1",
    "env": [
      "YOLO_AUTO_API_KEY"
    ],
    "models": [
      {
        "id": "deepseek-flash-v4",
        "name": "DeepSeek Flash V4",
        "contextWindow": 131072,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "contextWindow": 262144,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "yolo",
        "name": "Yolo",
        "contextWindow": 262144,
        "maxTokens": 131072,
        "input": [
          "text",
          "image"
        ]
      }
    ]
  }
])

/** Fast lookup by route id. */
export const EXTRA_PROVIDER_MAP: ReadonlyMap<string, ExtraProvider> = new Map(EXTRA_PROVIDERS.map(provider => [provider.id, provider]))
