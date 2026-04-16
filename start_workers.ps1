# Reads GROQ_KEY from .env and starts 2 background workers
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir ".env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match "^\s*([^#][^=]+)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
        }
    }
}
$env:REDIS_URL = "redis://localhost:6379"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:WORKER_ID='worker1'; Set-Location '$ScriptDir'; python worker.py"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:WORKER_ID='worker2'; Set-Location '$ScriptDir'; python worker.py"
Write-Host "Workers started in background."
