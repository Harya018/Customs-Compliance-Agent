# Kubernetes Minikube Deployment — Customs Compliance Agent

## Prerequisites
- [minikube](https://minikube.sigs.k8s.io/docs/start/) installed
- [kubectl](https://kubernetes.io/docs/tasks/tools/) installed
- Docker Desktop running

## Quick Deploy (PowerShell)
```powershell
.\k8s\deploy.ps1
```

## Manual Steps

### 1. Start Minikube
```powershell
minikube start
```

### 2. Point Docker to Minikube registry
```powershell
minikube docker-env | Invoke-Expression
```

### 3. Build images inside Minikube
```powershell
docker build -t customsagent-backend:latest .
docker build -t customsagent-frontend:latest ./frontend
```

### 4. Apply all manifests
```powershell
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/redis-pvc.yaml
kubectl apply -f k8s/backend-pvc.yaml
kubectl apply -f k8s/redis-deployment.yaml
kubectl apply -f k8s/redis-service.yaml
kubectl apply -f k8s/backend-deployment.yaml
kubectl apply -f k8s/backend-service.yaml
kubectl apply -f k8s/frontend-deployment.yaml
kubectl apply -f k8s/frontend-service.yaml
kubectl apply -f k8s/worker-deployment.yaml
kubectl apply -f k8s/hpa.yaml
```

### 5. Check pod status
```powershell
kubectl get pods -n customs-agent
```

### 6. Stream backend logs
```powershell
kubectl logs -f deployment/backend -n customs-agent
```

### 7. Access the app
```powershell
minikube service frontend-service -n customs-agent --url
```
Open the printed URL in your browser.

## Architecture in Kubernetes
```
Internet → minikube-ip:30000 (NodePort)
             → frontend-service → frontend pod
             → backend-service  → backend pod (x2, readiness probed)
             → redis-service    → redis pod (persistent volume)
             → worker pods (x2-10, auto-scaled via HPA)
```

## Scaling workers manually
```powershell
kubectl scale deployment worker --replicas=5 -n customs-agent
```

## Update secrets
Edit `k8s/secrets.yaml` with your new base64-encoded values, then:
```powershell
kubectl apply -f k8s/secrets.yaml
kubectl rollout restart deployment/backend -n customs-agent
```
