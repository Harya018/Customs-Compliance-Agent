# Step 1: Start minikube
minikube start

# Step 2: Point Docker to minikube registry
minikube docker-env | Invoke-Expression

# Step 3: Build images inside minikube
docker build -t customsagent-backend:latest .
docker build -t customsagent-frontend:latest ./frontend

# Step 4: Apply all manifests in order
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

# Step 5: Wait for pods
kubectl wait --for=condition=ready pod --all -n customs-agent --timeout=120s

# Step 6: Get URL
minikube service frontend-service -n customs-agent --url
