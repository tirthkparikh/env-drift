import os
import environ
env = environ.Env()
SECRET_KEY = env('DJANGO_SECRET_KEY')
DEBUG = env.bool('DEBUG', default=False)
REDIS_URL = os.environ['REDIS_URL']
CELERY_BROKER = os.getenv('CELERY_BROKER_URL', 'redis://localhost:6379/0')
OPENAI = os.environ.get('OPENAI_API_KEY')
