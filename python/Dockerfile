FROM apache/airflow:2.11.0-python3.11

# Install netcat for database readiness check
USER root
RUN apt-get update && apt-get install -y netcat-traditional && rm -rf /var/lib/apt/lists/*

# Install Airflow providers and core dependencies
USER airflow
RUN pip install \
    "apache-airflow-providers-amazon>=9.9.0" \
    apache-airflow-providers-postgres \
    apache-airflow-providers-openlineage \
    typing-extensions==4.8.0 \
    requests \
    boto3

# Force correct typing-extensions version
RUN pip install --upgrade --force-reinstall typing-extensions>=4.8.0

RUN pip install \
    "pydantic>=2,<3" \
    psycopg2-binary \
    "psycopg[binary]" \
    python-dateutil \
    confluent-kafka

# ========================================
# EMBEDDING GENERATION DEPENDENCIES
# ========================================
RUN pip install \
    "onnxruntime>=1.16.0,<2.0.0" \
    "tokenizers>=0.15.0,<1.0.0" \
    "numpy>=1.26.0,<2.0.0"

# ========================================
# S3 PARQUET EXPORT DEPENDENCIES
# ========================================
RUN pip install \
    "s3fs>=2023.6.0,<2024.0.0" \
    "pyarrow>=13.0.0,<14.0.0"

# Copy entrypoint script
USER root
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER airflow
