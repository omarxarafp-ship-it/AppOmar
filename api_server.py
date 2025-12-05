#!/usr/bin/env python3
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import httpx
import asyncio
import aiofiles
import re
import time
import os
import uuid
import hashlib
import subprocess
import signal
from typing import Optional, Dict, Any, Set, List
from collections import defaultdict
import uvicorn
import sys
import random
from contextlib import asynccontextmanager
from bs4 import BeautifulSoup
from datetime import datetime
from curl_cffi import requests as curl_requests
from curl_cffi.requests import AsyncSession
import aria2p

from apkpure_client import APKPureClient, get_smart_download_info

DOWNLOADS_DIR = os.path.join(os.path.dirname(__file__), 'app_cache')
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

url_cache: Dict[str, tuple] = {}
URL_CACHE_TTL = 1800

file_cache: Dict[str, Dict[str, Any]] = {}

download_locks: Dict[str, asyncio.Lock] = {}
user_downloads: Dict[str, Set[str]] = defaultdict(set)

pending_deletions: Dict[str, asyncio.Task] = {}

http_client: Optional[httpx.AsyncClient] = None

aria2_client: Optional[aria2p.API] = None
aria2_process: Optional[subprocess.Popen] = None

stats = {
    "total_requests": 0,
    "cache_hits": 0,
    "downloads": 0,
    "active_downloads": 0,
    "cached_files": 0,
    "aria2_downloads": 0,
    "aria2_success": 0,
    "aria2_failed": 0
}

def get_client() -> httpx.AsyncClient:
    if http_client is None:
        raise RuntimeError("HTTP client not initialized")
    return http_client

def get_download_lock(package_name: str) -> asyncio.Lock:
    if package_name not in download_locks:
        download_locks[package_name] = asyncio.Lock()
    return download_locks[package_name]

def generate_user_file_id(package_name: str, user_id: Optional[str] = None) -> str:
    unique_id = user_id or str(uuid.uuid4())[:8]
    return f"{package_name}_{unique_id}_{int(time.time())}"

async def schedule_file_deletion(file_path: str, delay: int = 30):
    await asyncio.sleep(delay)
    try:
        if os.path.exists(file_path):
            os.remove(file_path)
            print(f"[Cleanup] Deleted: {os.path.basename(file_path)}", file=sys.stderr)
            
            for pkg, info in list(file_cache.items()):
                if info.get('file_path') == file_path:
                    del file_cache[pkg]
                    stats["cached_files"] = max(0, stats["cached_files"] - 1)
                    break
    except Exception as e:
        print(f"[Cleanup Error] {file_path}: {e}", file=sys.stderr)

def cleanup_old_files():
    try:
        now = time.time()
        max_age = 300
        
        for filename in os.listdir(DOWNLOADS_DIR):
            file_path = os.path.join(DOWNLOADS_DIR, filename)
            if os.path.isfile(file_path):
                file_age = now - os.path.getmtime(file_path)
                if file_age > max_age:
                    os.remove(file_path)
                    print(f"[Cleanup] Removed old file: {filename}", file=sys.stderr)
    except Exception as e:
        print(f"[Cleanup Error] {e}", file=sys.stderr)

async def periodic_cleanup():
    while True:
        await asyncio.sleep(60)
        cleanup_old_files()

def start_aria2_daemon():
    global aria2_process, aria2_client
    try:
        try:
            test_client = aria2p.API(
                aria2p.Client(host="http://localhost", port=6800, secret="")
            )
            test_client.get_stats()
            print("[aria2] Daemon already running", file=sys.stderr)
            aria2_client = test_client
            return True
        except:
            pass
        
        print("[aria2] Starting aria2c daemon...", file=sys.stderr)
        aria2_process = subprocess.Popen(
            [
                "aria2c",
                "--enable-rpc",
                "--rpc-listen-all=false",
                "--rpc-listen-port=6800",
                "--max-concurrent-downloads=100",
                "--max-connection-per-server=16",
                "--split=16",
                "--min-split-size=1M",
                "--max-overall-download-limit=0",
                "--max-download-limit=0",
                "--file-allocation=none",
                "--continue=true",
                "--auto-file-renaming=false",
                "--allow-overwrite=true",
                "--check-certificate=false",
                "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                f"--dir={DOWNLOADS_DIR}",
                "--daemon=false",
                "--quiet=true"
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        
        time.sleep(2)
        
        aria2_client = aria2p.API(
            aria2p.Client(host="http://localhost", port=6800, secret="")
        )
        
        aria2_client.get_stats()
        print("[aria2] Daemon started successfully with high-concurrency settings", file=sys.stderr)
        return True
        
    except Exception as e:
        print(f"[aria2] Failed to start daemon: {e}", file=sys.stderr)
        aria2_client = None
        return False

def stop_aria2_daemon():
    global aria2_process
    if aria2_process:
        try:
            aria2_process.terminate()
            aria2_process.wait(timeout=5)
        except:
            try:
                aria2_process.kill()
            except:
                pass
        aria2_process = None
        print("[aria2] Daemon stopped", file=sys.stderr)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(120.0, connect=30.0),
        limits=httpx.Limits(max_connections=2000, max_keepalive_connections=1000),
        follow_redirects=True,
        headers={
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
    )
    
    start_aria2_daemon()
    
    asyncio.create_task(periodic_cleanup())
    
    print("[Server] Started with aria2 high-performance configuration", file=sys.stderr)
    yield
    
    for task in pending_deletions.values():
        task.cancel()
    
    stop_aria2_daemon()
    
    if http_client:
        await http_client.aclose()

app = FastAPI(title="AppOmar APK Download API", version="5.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4.1 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
]

download_semaphore = asyncio.Semaphore(200)

def get_headers() -> Dict[str, str]:
    return {
        'User-Agent': random.choice(USER_AGENTS),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
    }

@app.get("/")
async def root() -> Dict[str, Any]:
    return {
        "service": "AppOmar APK Download API",
        "version": "5.0.0",
        "status": "running",
        "source": "APKPure Only",
        "features": ["aria2_downloads", "file_caching", "auto_cleanup", "100_concurrent_downloads"],
        "aria2_status": "running" if aria2_client else "not available"
    }

@app.get("/health")
async def health_check() -> Dict[str, str]:
    return {"status": "healthy", "aria2": "running" if aria2_client else "not available"}

@app.get("/stats")
async def get_server_stats() -> Dict[str, Any]:
    aria2_stats = {}
    if aria2_client:
        try:
            aria2_stat = aria2_client.get_stats()
            aria2_stats = {
                "aria2_active": aria2_stat.num_active,
                "aria2_waiting": aria2_stat.num_waiting,
                "aria2_stopped": aria2_stat.num_stopped,
                "aria2_download_speed": aria2_stat.download_speed,
            }
        except:
            pass
    
    return {
        **stats,
        "cached_urls": len(url_cache),
        "cached_files": len([f for f in os.listdir(DOWNLOADS_DIR) if os.path.isfile(os.path.join(DOWNLOADS_DIR, f))]),
        "active_locks": len([l for l in download_locks.values() if l.locked()]),
        "pending_deletions": len(pending_deletions),
        **aria2_stats
    }

async def get_apkpure_app_slug(package_name: str) -> Optional[str]:
    try:
        client = get_client()
        search_url = f"https://apkpure.com/search?q={package_name}"
        response = await client.get(search_url, headers=get_headers())
        
        if response.status_code != 200:
            return None
            
        soup = BeautifulSoup(response.text, 'html.parser')
        
        for link in soup.find_all('a', href=True):
            href_attr = link.get('href')
            href = str(href_attr) if href_attr else ''
            if f'/{package_name}' in href and '/download' not in href:
                parts = href.strip('/').split('/')
                if len(parts) >= 1:
                    return parts[0]
        
        return package_name
    except Exception as e:
        print(f"[Slug] {package_name}: {e}", file=sys.stderr)
        return package_name

async def detect_apkpure_file_type(package_name: str) -> str:
    """Detect actual file type from APKPure page (APK or XAPK)"""
    try:
        client = get_client()
        slug = await get_apkpure_app_slug(package_name)
        if not slug:
            slug = package_name
        
        app_page_url = f"https://apkpure.com/{slug}/{package_name}"
        response = await client.get(app_page_url, headers=get_headers())
        
        if response.status_code != 200:
            return "apk"
        
        soup = BeautifulSoup(response.text, 'html.parser')
        page_text = response.text.lower()
        
        download_btn = soup.find('a', class_=re.compile(r'download', re.I))
        if download_btn:
            btn_text = download_btn.get_text().lower()
            data_type = str(download_btn.get('data-dt-file-type', '')).lower()
            
            if 'xapk' in data_type or 'xapk' in btn_text:
                print(f"[APKPure] {package_name}: Detected XAPK from button", file=sys.stderr)
                return "xapk"
            elif 'apk' in data_type or 'apk' in btn_text:
                if 'xapk' not in btn_text:
                    print(f"[APKPure] {package_name}: Detected APK from button", file=sys.stderr)
                    return "apk"
        
        file_info = soup.find('span', class_=re.compile(r'file.?type', re.I))
        if file_info:
            info_text = file_info.get_text().lower()
            if 'xapk' in info_text:
                print(f"[APKPure] {package_name}: Detected XAPK from file-info", file=sys.stderr)
                return "xapk"
            elif 'apk' in info_text:
                print(f"[APKPure] {package_name}: Detected APK from file-info", file=sys.stderr)
                return "apk"
        
        for elem in soup.find_all(['span', 'div', 'p'], class_=re.compile(r'info|detail|meta', re.I)):
            text = elem.get_text().lower()
            if 'xapk' in text and len(text) < 50:
                print(f"[APKPure] {package_name}: Detected XAPK from metadata", file=sys.stderr)
                return "xapk"
        
        if re.search(r'\bxapk\b', page_text):
            xapk_count = len(re.findall(r'\bxapk\b', page_text))
            apk_count = len(re.findall(r'\bapk\b', page_text)) - xapk_count
            if xapk_count > apk_count:
                print(f"[APKPure] {package_name}: Detected XAPK from page content (xapk:{xapk_count} vs apk:{apk_count})", file=sys.stderr)
                return "xapk"
        
        print(f"[APKPure] {package_name}: Defaulting to APK", file=sys.stderr)
        return "apk"
        
    except Exception as e:
        print(f"[APKPure Detect] {package_name}: {e}", file=sys.stderr)
        return "apk"

async def resolve_apkpure_download_url(package_name: str, file_type: str = "XAPK") -> Optional[str]:
    try:
        client = get_client()
        slug = await get_apkpure_app_slug(package_name)
        if not slug:
            slug = package_name
        
        download_page_url = f"https://apkpure.com/{slug}/{package_name}/download"
        
        response = await client.get(download_page_url, headers=get_headers())
        
        if response.status_code != 200:
            return None
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        download_link = soup.find('a', {'id': 'download_link'})
        if download_link:
            href_attr = download_link.get('href')
            if href_attr:
                url = str(href_attr)
                if url.startswith('http'):
                    return url
        
        for a_tag in soup.find_all('a', href=True):
            href_attr = a_tag.get('href')
            href = str(href_attr) if href_attr else ''
            if 'download.apkpure.com' in href or 'd.apkpure.com' in href:
                if 'token' in href or 'key' in href:
                    return href
        
        iframe = soup.find('iframe', {'id': 'iframe_download'})
        if iframe:
            src_attr = iframe.get('src')
            if src_attr:
                return str(src_attr)
        
        meta_refresh = soup.find('meta', {'http-equiv': 'refresh'})
        if meta_refresh:
            content_attr = meta_refresh.get('content')
            content = str(content_attr) if content_attr else ''
            match = re.search(r'url=(.+)', content, re.IGNORECASE)
            if match:
                return match.group(1).strip()
        
        scripts = soup.find_all('script')
        for script in scripts:
            script_text = script.string or ''
            url_match = re.search(r'(https?://[^"\'<>\s]+\.(?:apk|xapk)[^"\'<>\s]*)', script_text, re.IGNORECASE)
            if url_match:
                return url_match.group(1)
        
        return None
        
    except Exception as e:
        print(f"[APKPure Resolve] {package_name}: {e}", file=sys.stderr)
        return None

def get_larger_version_from_versions_page(package_name: str, min_size_mb: int = 150) -> Optional[Dict[str, Any]]:
    """Search versions page for a larger/complete version if latest is too small"""
    try:
        import cloudscraper
        scraper = cloudscraper.create_scraper(
            browser={'browser': 'chrome', 'platform': 'darwin', 'desktop': True}
        )
        
        slug = package_name.split('.')[-1]
        versions_url = f"https://apkpure.com/{slug}/{package_name}/versions"
        
        print(f"[APKPure Versions] Searching for larger version at: {versions_url}", file=sys.stderr)
        response = scraper.get(versions_url, timeout=30)
        
        if response.status_code != 200:
            search_url = f"https://apkpure.com/search?q={package_name}"
            search_resp = scraper.get(search_url, timeout=30)
            if search_resp.status_code == 200:
                soup = BeautifulSoup(search_resp.text, 'html.parser')
                for link in soup.find_all('a', href=True):
                    href = str(link.get('href', ''))
                    if f'/{package_name}' in href and '/download' not in href:
                        parts = href.strip('/').split('/')
                        if len(parts) >= 1:
                            slug = parts[0]
                            break
                versions_url = f"https://apkpure.com/{slug}/{package_name}/versions"
                response = scraper.get(versions_url, timeout=30)
        
        if response.status_code != 200:
            return None
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        versions_with_size = []
        
        for a in soup.find_all('a', href=re.compile(r'/download/\d+\.\d+')):
            href = a.get('href', '')
            parent = a.find_parent(['div', 'li', 'tr'])
            if parent:
                parent_text = parent.get_text()
                
                version_match = re.search(r'/download/(\d+\.\d+\.\d+)', href)
                version = version_match.group(1) if version_match else None
                
                size_match = re.search(r'(\d+\.?\d*)\s*(MB|GB)', parent_text, re.I)
                if size_match and version:
                    size_val = float(size_match.group(1))
                    size_unit = size_match.group(2).upper()
                    if size_unit == 'GB':
                        size_val *= 1024
                    
                    if version not in [v['version'] for v in versions_with_size]:
                        versions_with_size.append({
                            'version': version,
                            'size_mb': size_val,
                            'download_page': href if href.startswith('http') else f"https://apkpure.com{href}"
                        })
        
        def version_key(v):
            parts = v['version'].split('.')
            return tuple(int(p) for p in parts)
        
        versions_with_size.sort(key=version_key, reverse=True)
        
        for ver in versions_with_size:
            if ver['size_mb'] >= min_size_mb:
                print(f"[APKPure Versions] Found latest complete version {ver['version']}: {ver['size_mb']:.1f} MB", file=sys.stderr)
                
                dl_page_resp = scraper.get(ver['download_page'], timeout=30)
                if dl_page_resp.status_code == 200:
                    dl_soup = BeautifulSoup(dl_page_resp.text, 'html.parser')
                    
                    dl_link = dl_soup.find('a', {'id': 'download_link'})
                    if dl_link:
                        download_url = dl_link.get('href', '')
                        if download_url.startswith('http'):
                            file_type = 'xapk' if 'xapk' in download_url.lower() else 'apk'
                            
                            head_resp = scraper.head(download_url, timeout=30, allow_redirects=True)
                            if head_resp.status_code == 200:
                                content_length = int(head_resp.headers.get('Content-Length', 0))
                                if content_length > min_size_mb * 1024 * 1024:
                                    print(f"[APKPure Versions] Verified download URL: {content_length / (1024*1024):.1f} MB", file=sys.stderr)
                                    return {
                                        "source": "apkpure",
                                        "download_url": download_url,
                                        "size": content_length,
                                        "file_type": file_type,
                                        "version": ver['version']
                                    }
                    
                    for a in dl_soup.find_all('a', href=True):
                        href = a.get('href', '')
                        if 'd.apkpure.com/b/XAPK' in href:
                            head_resp = scraper.head(href, timeout=30, allow_redirects=True)
                            if head_resp.status_code == 200:
                                content_length = int(head_resp.headers.get('Content-Length', 0))
                                if content_length > min_size_mb * 1024 * 1024:
                                    return {
                                        "source": "apkpure",
                                        "download_url": href,
                                        "size": content_length,
                                        "file_type": "xapk",
                                        "version": ver['version']
                                    }
        
        return None
        
    except Exception as e:
        print(f"[APKPure Versions] Error: {e}", file=sys.stderr)
        return None

def get_apkpure_info_sync(package_name: str, min_size_mb: int = 150) -> Optional[Dict[str, Any]]:
    try:
        safari_versions = ["safari15_3", "safari15_5", "safari17_0", "safari17_2_macos"]
        
        latest_result = None
        
        for safari_ver in safari_versions:
            try:
                xapk_url = f"https://d.apkpure.com/b/XAPK/{package_name}?version=latest"
                response = curl_requests.head(
                    xapk_url,
                    impersonate=safari_ver,
                    timeout=30,
                    allow_redirects=True
                )
                
                if response.status_code == 200:
                    content_type = response.headers.get('Content-Type', '')
                    if 'html' not in content_type.lower():
                        content_length = int(response.headers.get('Content-Length', 0))
                        size_mb = content_length / (1024 * 1024)
                        
                        if size_mb >= min_size_mb:
                            print(f"[APKPure curl-cffi] Found XAPK for {package_name}: {size_mb:.1f} MB (OK)", file=sys.stderr)
                            return {
                                "source": "apkpure",
                                "download_url": xapk_url,
                                "size": content_length,
                                "file_type": "xapk",
                                "impersonate": safari_ver
                            }
                        else:
                            print(f"[APKPure curl-cffi] Latest XAPK too small: {size_mb:.1f} MB < {min_size_mb} MB", file=sys.stderr)
                            latest_result = {
                                "source": "apkpure",
                                "download_url": xapk_url,
                                "size": content_length,
                                "file_type": "xapk"
                            }
                
                apk_url = f"https://d.apkpure.com/b/APK/{package_name}?version=latest"
                response = curl_requests.head(
                    apk_url,
                    impersonate=safari_ver,
                    timeout=30,
                    allow_redirects=True
                )
                
                if response.status_code == 200:
                    content_type = response.headers.get('Content-Type', '')
                    if 'html' not in content_type.lower():
                        content_length = int(response.headers.get('Content-Length', 0))
                        final_url = str(response.url)
                        size_mb = content_length / (1024 * 1024)
                        
                        file_type = 'xapk' if 'xapk' in final_url.lower() else 'apk'
                        
                        if size_mb >= min_size_mb:
                            print(f"[APKPure curl-cffi] Found {file_type.upper()} for {package_name}: {size_mb:.1f} MB (OK)", file=sys.stderr)
                            return {
                                "source": "apkpure",
                                "download_url": apk_url,
                                "size": content_length,
                                "file_type": file_type,
                                "impersonate": safari_ver
                            }
                        elif not latest_result:
                            latest_result = {
                                "source": "apkpure",
                                "download_url": apk_url,
                                "size": content_length,
                                "file_type": file_type
                            }
                
                break
                
            except Exception as e:
                print(f"[APKPure curl-cffi] {safari_ver} failed: {e}", file=sys.stderr)
                continue
        
        print(f"[APKPure] Searching for larger version in versions page...", file=sys.stderr)
        larger_version = get_larger_version_from_versions_page(package_name, min_size_mb)
        if larger_version:
            return larger_version
        
        if latest_result:
            print(f"[APKPure] Using latest version (small): {latest_result.get('size', 0) / (1024*1024):.1f} MB", file=sys.stderr)
            return latest_result
        
        return None
    except Exception as e:
        print(f"[APKPure curl-cffi] {package_name}: {e}", file=sys.stderr)
        return None

async def get_apkpure_info(package_name: str) -> Optional[Dict[str, Any]]:
    try:
        detected_type = await detect_apkpure_file_type(package_name)
        print(f"[APKPure] {package_name}: Detected type = {detected_type.upper()}", file=sys.stderr)
        
        client = get_client()
        
        primary_type = detected_type.upper()
        fallback_type = "XAPK" if primary_type == "APK" else "APK"
        
        primary_url = f"https://d.apkpure.com/b/{primary_type}/{package_name}?version=latest"
        response = await client.head(primary_url, headers=get_headers(), follow_redirects=True)
        
        if response.status_code == 200:
            content_type = response.headers.get('Content-Type', '')
            if 'html' not in content_type.lower():
                content_length = int(response.headers.get('Content-Length', 0))
                if content_length > 100000:
                    print(f"[APKPure] {package_name}: Found {primary_type} ({content_length} bytes)", file=sys.stderr)
                    return {
                        "source": "apkpure",
                        "download_url": primary_url,
                        "size": content_length,
                        "file_type": detected_type
                    }
        
        fallback_url = f"https://d.apkpure.com/b/{fallback_type}/{package_name}?version=latest"
        response = await client.head(fallback_url, headers=get_headers(), follow_redirects=True)
        
        if response.status_code == 200:
            content_type = response.headers.get('Content-Type', '')
            if 'html' not in content_type.lower():
                content_length = int(response.headers.get('Content-Length', 0))
                if content_length > 100000:
                    fallback_file_type = fallback_type.lower()
                    print(f"[APKPure] {package_name}: Fallback to {fallback_type} ({content_length} bytes)", file=sys.stderr)
                    return {
                        "source": "apkpure",
                        "download_url": fallback_url,
                        "size": content_length,
                        "file_type": fallback_file_type
                    }
        
        resolved_url = await resolve_apkpure_download_url(package_name, primary_type)
        if resolved_url:
            try:
                check_response = await client.head(resolved_url, headers=get_headers(), follow_redirects=True)
                if check_response.status_code == 200:
                    content_type = check_response.headers.get('Content-Type', '')
                    content_length = int(check_response.headers.get('Content-Length', 0))
                    
                    if 'html' not in content_type.lower() or content_length > 1000000:
                        file_type = 'xapk' if 'xapk' in resolved_url.lower() else 'apk'
                        return {
                            "source": "apkpure",
                            "download_url": resolved_url,
                            "size": content_length,
                            "file_type": file_type
                        }
            except Exception as e:
                pass
        
        return None
    except Exception as e:
        print(f"[APKPure] {package_name}: {e}", file=sys.stderr)
        return None

async def get_download_info(package_name: str) -> Dict[str, Any]:
    """Smart download info using unified APKPure client with intelligent type detection"""
    stats["total_requests"] += 1
    cache_key = package_name
    now = time.time()
    
    if cache_key in url_cache:
        cached, timestamp = url_cache[cache_key]
        if now - timestamp < URL_CACHE_TTL:
            stats["cache_hits"] += 1
            print(f"[Cache Hit] {package_name} from {cached.get('source', 'unknown')}", file=sys.stderr)
            return cached
    
    result = await asyncio.get_event_loop().run_in_executor(
        None, 
        lambda: get_smart_download_info(package_name, debug=True)
    )
    
    if not result:
        result = await get_apkpure_info(package_name)
    
    if not result:
        print(f"[Fallback] Using direct APKPure URL for {package_name}", file=sys.stderr)
        for file_type in ["XAPK", "APK"]:
            url = f"https://d.apkpure.com/b/{file_type}/{package_name}?version=latest"
            try:
                client = get_client()
                head_resp = await client.head(url, headers=get_headers(), follow_redirects=True)
                if head_resp.status_code == 200:
                    content_type = head_resp.headers.get('Content-Type', '')
                    content_length = int(head_resp.headers.get('Content-Length', 0))
                    if 'html' not in content_type.lower() and content_length > 100000:
                        print(f"[Fallback] Found {file_type}: {content_length / (1024*1024):.2f} MB", file=sys.stderr)
                        result = {
                            "source": "apkpure",
                            "download_url": url,
                            "size": content_length,
                            "file_type": file_type.lower()
                        }
                        break
            except Exception as e:
                print(f"[Fallback] {file_type} check failed: {e}", file=sys.stderr)
        
        if not result:
            result = {
                "source": "apkpure",
                "download_url": f"https://d.apkpure.com/b/XAPK/{package_name}?version=latest",
                "size": 0,
                "file_type": "xapk"
            }
    
    result["package_name"] = package_name
    url_cache[cache_key] = (result, now)
    
    file_type = result.get('file_type', 'unknown').upper()
    size_mb = result.get('size', 0) / (1024*1024)
    detected_from = result.get('detected_from', 'unknown')
    print(f"[Download Info] {package_name} -> Type: {file_type}, Size: {size_mb:.1f} MB, Detected from: {detected_from}", file=sys.stderr)
    return result

@app.get("/info/{package_name}")
async def get_apk_info(package_name: str) -> Dict[str, Any]:
    try:
        info = await get_download_info(package_name)
        return {
            "package_name": package_name,
            "source": info.get("source"),
            "size": info.get("size", 0),
            "file_type": info.get("file_type", "apk"),
            "version": info.get("version", "Latest")
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/url/{package_name}")
async def get_download_url(package_name: str) -> Dict[str, Any]:
    try:
        info = await get_download_info(package_name)
        return {
            "success": True,
            "url": info['download_url'],
            "filename": f"{package_name}.{info.get('file_type', 'apk')}",
            "size": info.get('size', 0),
            "source": info.get('source'),
            "file_type": info.get('file_type', 'apk')
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/direct-url/{package_name}")
async def get_direct_download_url(package_name: str) -> Dict[str, Any]:
    try:
        info = await get_download_info(package_name)
        download_url = info['download_url']
        file_type = info.get('file_type', 'apk')
        
        headers_for_download = {
            'User-Agent': random.choice(USER_AGENTS),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Referer': 'https://apkpure.com/',
            'Origin': 'https://apkpure.com',
            'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-site',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        }
        
        return {
            "success": True,
            "url": download_url,
            "filename": f"{package_name}.{file_type}",
            "size": info.get('size', 0),
            "source": info.get('source'),
            "file_type": file_type,
            "headers": headers_for_download
        }
    except Exception as e:
        print(f"[Direct URL Error] {package_name}: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=str(e))

def download_with_aria2(download_url: str, file_path: str, package_name: str) -> bool:
    global aria2_client
    if not aria2_client:
        return False
    
    try:
        stats["aria2_downloads"] += 1
        print(f"[aria2] Starting download for {package_name}...", file=sys.stderr)
        
        filename = os.path.basename(file_path)
        
        options = {
            "out": filename,
            "dir": DOWNLOADS_DIR,
            "max-connection-per-server": "16",
            "split": "16",
            "min-split-size": "1M",
            "header": [
                f"User-Agent: {random.choice(USER_AGENTS)}",
                "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language: en-US,en;q=0.9",
                "Referer: https://apkpure.com/",
            ],
            "check-certificate": "false",
            "allow-overwrite": "true",
            "auto-file-renaming": "false",
        }
        
        download = aria2_client.add_uris([download_url], options=options)
        
        timeout = 600
        start_time = time.time()
        last_progress = 0
        
        while True:
            download.update()
            
            if download.is_complete:
                file_size = download.total_length
                elapsed = time.time() - start_time
                speed = file_size / elapsed / 1024 / 1024 if elapsed > 0 else 0
                print(f"[aria2] Downloaded {package_name}: {file_size / 1024 / 1024:.2f} MB in {elapsed:.1f}s ({speed:.2f} MB/s)", file=sys.stderr)
                stats["aria2_success"] += 1
                return True
            
            if download.has_failed:
                error = download.error_message or "Unknown error"
                print(f"[aria2] Download failed for {package_name}: {error}", file=sys.stderr)
                stats["aria2_failed"] += 1
                return False
            
            if download.total_length > 0:
                progress = (download.completed_length / download.total_length) * 100
                if progress - last_progress >= 10:
                    print(f"[aria2] {package_name}: {progress:.0f}% ({download.completed_length / 1024 / 1024:.1f} MB)", file=sys.stderr)
                    last_progress = progress
            
            if time.time() - start_time > timeout:
                print(f"[aria2] Download timeout for {package_name}", file=sys.stderr)
                try:
                    download.remove(force=True)
                except:
                    pass
                stats["aria2_failed"] += 1
                return False
            
            time.sleep(0.5)
            
    except Exception as e:
        print(f"[aria2] Error downloading {package_name}: {e}", file=sys.stderr)
        stats["aria2_failed"] += 1
        return False

MIN_VALID_FILE_SIZE = 500000

def is_html_content(content: bytes) -> bool:
    """Check if content is HTML (error page) instead of binary file"""
    if len(content) < MIN_VALID_FILE_SIZE:
        try:
            text = content[:1000].decode('utf-8', errors='ignore').lower()
            if '<html' in text or '<!doctype' in text or '<head' in text:
                return True
        except:
            pass
    return False

def download_with_curl_cffi(download_url: str, file_path: str, package_name: str) -> bool:
    safari_versions = ["safari15_3", "safari15_5", "safari17_0", "safari17_2_macos"]
    
    for safari_ver in safari_versions:
        try:
            print(f"[curl-cffi] Downloading {package_name} with {safari_ver}...", file=sys.stderr)
            response = curl_requests.get(
                download_url,
                impersonate=safari_ver,
                timeout=300,
                allow_redirects=True
            )
            
            if response.status_code == 200:
                content = response.content
                content_type = response.headers.get('Content-Type', '')
                
                if is_html_content(content):
                    print(f"[curl-cffi] {safari_ver} returned HTML page ({len(content)} bytes), trying next...", file=sys.stderr)
                    continue
                
                if len(content) < MIN_VALID_FILE_SIZE:
                    print(f"[curl-cffi] {safari_ver} file too small ({len(content)} bytes), trying next...", file=sys.stderr)
                    continue
                
                with open(file_path, 'wb') as f:
                    f.write(content)
                file_size = os.path.getsize(file_path)
                print(f"[curl-cffi] Downloaded {package_name}: {file_size / 1024 / 1024:.2f} MB", file=sys.stderr)
                return True
            
            print(f"[curl-cffi] {safari_ver} returned {response.status_code}", file=sys.stderr)
            
        except Exception as e:
            print(f"[curl-cffi] {safari_ver} failed: {e}", file=sys.stderr)
            continue
    
    return False

def validate_downloaded_file(file_path: str, package_name: str) -> bool:
    """Validate downloaded file is not HTML error page"""
    if not os.path.exists(file_path):
        return False
    
    file_size = os.path.getsize(file_path)
    
    if file_size < MIN_VALID_FILE_SIZE:
        print(f"[Validate] {package_name}: File too small ({file_size} bytes)", file=sys.stderr)
        
        try:
            with open(file_path, 'rb') as f:
                header = f.read(1000)
            if is_html_content(header):
                print(f"[Validate] {package_name}: File contains HTML content!", file=sys.stderr)
                return False
        except:
            pass
        
        return False
    
    return True

async def download_file_to_cache(package_name: str, download_url: str, file_type: str, retry_count: int = 0) -> Optional[str]:
    lock = get_download_lock(package_name)
    max_retries = 2
    
    async with lock:
        cache_key = f"{package_name}_{hashlib.md5(download_url.encode()).hexdigest()[:8]}"
        
        if cache_key in file_cache:
            cached_info = file_cache[cache_key]
            if os.path.exists(cached_info['file_path']):
                if validate_downloaded_file(cached_info['file_path'], package_name):
                    if cache_key in pending_deletions:
                        pending_deletions[cache_key].cancel()
                        del pending_deletions[cache_key]
                    
                    deletion_task = asyncio.create_task(schedule_file_deletion(cached_info['file_path'], 30))
                    pending_deletions[cache_key] = deletion_task
                    
                    return cached_info['file_path']
                else:
                    print(f"[Cache] {package_name}: Cached file is invalid, removing...", file=sys.stderr)
                    try:
                        os.remove(cached_info['file_path'])
                    except:
                        pass
                    del file_cache[cache_key]
        
        file_id = generate_user_file_id(package_name)
        file_path = os.path.join(DOWNLOADS_DIR, f"{file_id}.{file_type}")
        
        async with download_semaphore:
            stats["active_downloads"] += 1
            try:
                loop = asyncio.get_event_loop()
                success = await loop.run_in_executor(
                    None, 
                    download_with_aria2, 
                    download_url, 
                    file_path, 
                    package_name
                )
                
                if success and not validate_downloaded_file(file_path, package_name):
                    print(f"[Download] aria2 downloaded invalid file, trying curl-cffi...", file=sys.stderr)
                    try:
                        os.remove(file_path)
                    except:
                        pass
                    success = False
                
                if not success:
                    print(f"[Download] aria2 failed, trying curl-cffi...", file=sys.stderr)
                    success = await loop.run_in_executor(
                        None, 
                        download_with_curl_cffi, 
                        download_url, 
                        file_path, 
                        package_name
                    )
                
                if success and not validate_downloaded_file(file_path, package_name):
                    print(f"[Download] curl-cffi downloaded invalid file, trying httpx...", file=sys.stderr)
                    try:
                        os.remove(file_path)
                    except:
                        pass
                    success = False
                
                if not success:
                    print(f"[Download] curl-cffi failed, trying httpx...", file=sys.stderr)
                    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=30.0), follow_redirects=True) as client:
                        async with client.stream("GET", download_url, headers=get_headers()) as response:
                            if response.status_code != 200:
                                raise HTTPException(status_code=response.status_code, detail="Download failed")
                            
                            content_type = response.headers.get('Content-Type', '')
                            if 'html' in content_type.lower():
                                content = await response.aread()
                                if len(content) < MIN_VALID_FILE_SIZE or is_html_content(content):
                                    raise HTTPException(status_code=400, detail="Got HTML instead of file")
                                async with aiofiles.open(file_path, 'wb') as f:
                                    await f.write(content)
                            else:
                                async with aiofiles.open(file_path, 'wb') as f:
                                    async for chunk in response.aiter_bytes(chunk_size=131072):
                                        await f.write(chunk)
                    
                    if not validate_downloaded_file(file_path, package_name):
                        raise HTTPException(status_code=400, detail="Downloaded file is invalid (HTML or too small)")
                
                file_size = os.path.getsize(file_path)
                
                file_cache[cache_key] = {
                    'file_path': file_path,
                    'file_type': file_type,
                    'size': file_size,
                    'created_at': time.time()
                }
                stats["cached_files"] += 1
                stats["downloads"] += 1
                
                deletion_task = asyncio.create_task(schedule_file_deletion(file_path, 30))
                pending_deletions[cache_key] = deletion_task
                
                print(f"[Download] {package_name}: {file_size / 1024 / 1024:.2f} MB saved to cache", file=sys.stderr)
                return file_path
                
            except Exception as e:
                if os.path.exists(file_path):
                    os.remove(file_path)
                
                if retry_count < max_retries and "HTML" in str(e):
                    print(f"[Download] Got HTML response, clearing cache and retrying ({retry_count + 1}/{max_retries})...", file=sys.stderr)
                    if package_name in url_cache:
                        del url_cache[package_name]
                    return None
                
                raise e
            finally:
                stats["active_downloads"] -= 1

async def batch_download_with_aria2(packages: List[Dict[str, Any]]) -> Dict[str, Any]:
    global aria2_client
    if not aria2_client:
        return {"success": False, "error": "aria2 not available", "results": []}
    
    results = []
    downloads = []
    
    print(f"[aria2 Batch] Starting batch download of {len(packages)} packages...", file=sys.stderr)
    
    for pkg in packages:
        package_name = pkg.get("package_name")
        download_url = pkg.get("download_url")
        file_type = pkg.get("file_type", "apk")
        
        file_id = generate_user_file_id(package_name)
        filename = f"{file_id}.{file_type}"
        file_path = os.path.join(DOWNLOADS_DIR, filename)
        
        try:
            options = {
                "out": filename,
                "dir": DOWNLOADS_DIR,
                "max-connection-per-server": "16",
                "split": "16",
                "min-split-size": "1M",
                "header": [
                    f"User-Agent: {random.choice(USER_AGENTS)}",
                    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language: en-US,en;q=0.9",
                    "Referer: https://apkpure.com/",
                ],
                "check-certificate": "false",
                "allow-overwrite": "true",
                "auto-file-renaming": "false",
            }
            
            download = aria2_client.add_uris([download_url], options=options)
            downloads.append({
                "download": download,
                "package_name": package_name,
                "file_path": file_path,
                "file_type": file_type
            })
            stats["aria2_downloads"] += 1
            
        except Exception as e:
            print(f"[aria2 Batch] Failed to add {package_name}: {e}", file=sys.stderr)
            results.append({
                "package_name": package_name,
                "success": False,
                "error": str(e)
            })
    
    print(f"[aria2 Batch] Added {len(downloads)} downloads to queue", file=sys.stderr)
    
    timeout = 600
    start_time = time.time()
    completed = set()
    
    while len(completed) < len(downloads):
        if time.time() - start_time > timeout:
            print(f"[aria2 Batch] Timeout reached", file=sys.stderr)
            break
        
        for item in downloads:
            if item["package_name"] in completed:
                continue
                
            try:
                item["download"].update()
                
                if item["download"].is_complete:
                    file_size = item["download"].total_length
                    results.append({
                        "package_name": item["package_name"],
                        "success": True,
                        "file_path": item["file_path"],
                        "file_type": item["file_type"],
                        "size": file_size
                    })
                    completed.add(item["package_name"])
                    stats["aria2_success"] += 1
                    print(f"[aria2 Batch] Completed: {item['package_name']} ({file_size / 1024 / 1024:.2f} MB)", file=sys.stderr)
                    
                elif item["download"].has_failed:
                    error = item["download"].error_message or "Unknown error"
                    results.append({
                        "package_name": item["package_name"],
                        "success": False,
                        "error": error
                    })
                    completed.add(item["package_name"])
                    stats["aria2_failed"] += 1
                    print(f"[aria2 Batch] Failed: {item['package_name']} - {error}", file=sys.stderr)
                    
            except Exception as e:
                results.append({
                    "package_name": item["package_name"],
                    "success": False,
                    "error": str(e)
                })
                completed.add(item["package_name"])
                stats["aria2_failed"] += 1
        
        await asyncio.sleep(0.5)
    
    for item in downloads:
        if item["package_name"] not in completed:
            try:
                item["download"].remove(force=True)
            except:
                pass
            results.append({
                "package_name": item["package_name"],
                "success": False,
                "error": "Timeout"
            })
            stats["aria2_failed"] += 1
    
    success_count = len([r for r in results if r.get("success")])
    print(f"[aria2 Batch] Completed: {success_count}/{len(packages)} successful", file=sys.stderr)
    
    return {
        "success": True,
        "total": len(packages),
        "successful": success_count,
        "failed": len(packages) - success_count,
        "results": results
    }

@app.post("/batch-download")
async def batch_download(packages: List[str]) -> Dict[str, Any]:
    if len(packages) > 100:
        raise HTTPException(status_code=400, detail="Maximum 100 packages per batch")
    
    package_infos = []
    
    print(f"[Batch] Fetching info for {len(packages)} packages...", file=sys.stderr)
    
    tasks = [get_download_info(pkg) for pkg in packages]
    infos = await asyncio.gather(*tasks, return_exceptions=True)
    
    for pkg, info in zip(packages, infos):
        if isinstance(info, Exception):
            print(f"[Batch] Failed to get info for {pkg}: {info}", file=sys.stderr)
            continue
        package_infos.append({
            "package_name": pkg,
            "download_url": info.get("download_url"),
            "file_type": info.get("file_type", "apk")
        })
    
    print(f"[Batch] Got info for {len(package_infos)} packages", file=sys.stderr)
    
    result = await batch_download_with_aria2(package_infos)
    return result

@app.get("/download/{package_name}")
async def download_apk(package_name: str, background_tasks: BackgroundTasks, user_id: Optional[str] = None):
    max_retries = 3
    last_error = None
    
    for retry in range(max_retries):
        try:
            if retry > 0:
                print(f"[Download] Retry {retry}/{max_retries} for {package_name}, clearing cache...", file=sys.stderr)
                if package_name in url_cache:
                    del url_cache[package_name]
            
            info = await get_download_info(package_name)
            download_url = info['download_url']
            file_type = info.get('file_type', 'apk')
            
            file_path = await download_file_to_cache(package_name, download_url, file_type, retry_count=retry)
            
            if not file_path or not os.path.exists(file_path):
                last_error = "Failed to download file"
                continue
            
            file_size = os.path.getsize(file_path)
            if file_size < MIN_VALID_FILE_SIZE:
                print(f"[Download] File too small ({file_size} bytes), retrying...", file=sys.stderr)
                try:
                    os.remove(file_path)
                except:
                    pass
                last_error = f"File too small ({file_size} bytes)"
                continue
            
            with open(file_path, 'rb') as f:
                header = f.read(100)
            if is_html_content(header + b'\x00' * 900):
                print(f"[Download] Got HTML content, retrying...", file=sys.stderr)
                try:
                    os.remove(file_path)
                except:
                    pass
                last_error = "Got HTML instead of APK"
                continue
            
            filename = f"{package_name}.{file_type}"
            
            return FileResponse(
                path=file_path,
                filename=filename,
                media_type="application/vnd.android.package-archive",
                headers={
                    "X-Source": str(info.get('source', 'apkpure')),
                    "X-File-Type": file_type,
                    "X-File-Size": str(file_size),
                    "Cache-Control": "no-cache"
                }
            )
                
        except HTTPException:
            raise
        except Exception as e:
            last_error = str(e)
            print(f"[Error] {package_name} (attempt {retry + 1}): {e}", file=sys.stderr)
            if retry < max_retries - 1:
                await asyncio.sleep(1)
    
    raise HTTPException(status_code=500, detail=f"Download failed after {max_retries} attempts: {last_error}")

@app.get("/file/{package_name}")
async def get_cached_file(package_name: str):
    try:
        info = await get_download_info(package_name)
        download_url = info['download_url']
        file_type = info.get('file_type', 'apk')
        
        file_path = await download_file_to_cache(package_name, download_url, file_type)
        
        if not file_path or not os.path.exists(file_path):
            raise HTTPException(status_code=500, detail="Failed to get file")
        
        return {
            "success": True,
            "file_path": file_path,
            "file_type": file_type,
            "size": os.path.getsize(file_path),
            "package_name": package_name,
            "source": info.get('source')
        }
            
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/cache")
async def clear_cache():
    global url_cache, file_cache
    
    for task in pending_deletions.values():
        task.cancel()
    pending_deletions.clear()
    
    for filename in os.listdir(DOWNLOADS_DIR):
        try:
            os.remove(os.path.join(DOWNLOADS_DIR, filename))
        except:
            pass
    
    url_cache = {}
    file_cache = {}
    
    return {"status": "cache_cleared", "source": "apkpure"}

@app.get("/search/{query}")
async def search_apps(query: str, limit: int = 20):
    """Search for apps on APKPure"""
    try:
        from apkpure_client import APKPureClient
        client = APKPureClient(debug=True)
        
        results = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: client.search(query, limit=limit)
        )
        
        return {
            "success": True,
            "query": query,
            "count": len(results),
            "results": results,
            "source": "apkpure"
        }
    except Exception as e:
        print(f"[Search Error] {query}: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info", workers=1)
