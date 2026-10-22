# 外部 Embedding API

Embedding 来源独立于运行模式：单机原生部署和后续的委托部署都可以直接调用外部 API，无需安装 sentence-transformers / PyTorch 或下载本地向量模型。这里的改动提供通用配置，并不代表双机委托协议已经实现。

## 网页配置

在「个人数据库 → 记忆语义检索 · Embedding 设置」选择「外部 API」，填写：

- API 根地址，例如 `https://example.com/v1`，程序自动追加 `/embeddings`。
- 服务商实际提供的 embedding 模型名称，不是聊天模型名称。
- 独立 API 密钥。留空保留已有密钥；勾选清除可移除独立密钥。

保存立即生效。「检查已保存配置」会发送一次测试文本，可能产生供应商费用；「重建索引」会向当前供应商发送参与索引的记忆文本。更换来源或模型后需重建索引；仅更换密钥无需重建。网页只显示密钥是否存在，不返回密钥原文。

配置在每份部署中分别保存。不移动原生环境，不修改另一台机器的配置，也不启动第二份 QQ 桥。同一机器人账号需要明确哪一份桥负责收发，避免两份同时回复。

## 环境变量配置

未通过网页保存的字段读取 `backend/.env`：

```dotenv
EMBED_ENGINE=cloud
EMBED_BASE_URL=https://example.com/v1
EMBED_API_KEY=your-embedding-key
EMBED_CLOUD_MODEL=your-embedding-model
```

修改环境变量后重启服务；网页保存的字段优先。保留原有本地模式默认值，不自动切换已有部署。

地址为空时使用服务端 `MODEL_BASE_URL`。仅复用聊天地址时，独立密钥为空会沿用 `MODEL_API_KEY`；指定其他地址时不会自动发送聊天密钥。独立地址允许无密钥的本地兼容服务。

接口采用 OpenAI 兼容的 `POST /embeddings`，请求 float 格式向量。连接超时 3 秒、读写超时 15 秒；超时、接口错误和无效向量会降级为关键词检索，记忆正文仍保留。不自动重试或偷偷加载本地模型。
