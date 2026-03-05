$ErrorActionPreference = "Continue"
Set-Location "C:\Projects\Docker-Claw"
$env:NODE_ENV = "development"

# Запуск сервера с перенаправлением вывода
$process = Start-Process -FilePath "node" -ArgumentList "server.js" -PassThru -NoNewWindow -RedirectStandardOutput "server_out.log" -RedirectStandardError "server_err.log"

# Ожидание запуска
Start-Sleep -Seconds 3

# Проверка вывода
if (Test-Path "server_out.log") {
    Write-Host "=== STDOUT ===" -ForegroundColor Cyan
    Get-Content "server_out.log"
}

if (Test-Path "server_err.log") {
    Write-Host "=== STDERR ===" -ForegroundColor Red
    Get-Content "server_err.log"
}

# Проверка, запущен ли процесс
if (!$process.HasExited) {
    Write-Host "`nServer started with PID: $($process.Id)" -ForegroundColor Green
    
    # Проверка порта
    $conn = Get-NetTCPConnection -LocalPort 3015 -ErrorAction SilentlyContinue
    if ($conn) {
        Write-Host "Server listening on http://localhost:3015" -ForegroundColor Green
    }
} else {
    Write-Host "Server exited with code: $($process.ExitCode)" -ForegroundColor Red
}
