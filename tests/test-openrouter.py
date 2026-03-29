import os
from openai import OpenAI

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.getenv("OPENROUTER_API_KEY"),   # или просто api_key= если вставил вручную
    default_headers={
        "HTTP-Referer": "https://github.com/digistaff-team/clientzavod",  # опционально, но полезно
        "X-OpenRouter-Title": "Client Zavod",                   # название твоего проекта
    }
)

response = client.chat.completions.create(
    model="z-ai/glm-4.5-air:free",                    # ← укажи модель нейросети
    messages=[
        {"role": "system", "content": "Ты копирайтер для соцсетей"},
        {"role": "user", "content": "Привет! Расскажи коротко, какие сейчас лучшие темы для постов в телеграм."}
    ],
    temperature=0.7,
    max_tokens=800
)

print(response.choices[0].message.content)