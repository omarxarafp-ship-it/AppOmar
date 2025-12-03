#!/usr/bin/env python3
"""
APKPure Smart Client - Unified module for intelligent APK/XAPK detection and download
Detects the actual file type from APKPure page and downloads the correct version
"""

import sys
import os
import re
import time
import hashlib
from typing import Optional, Dict, Any, Tuple
from dataclasses import dataclass
from enum import Enum

try:
    import cloudscraper
except ImportError:
    cloudscraper = None

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None

try:
    from curl_cffi import requests as curl_requests
except ImportError:
    curl_requests = None

try:
    import httpx
except ImportError:
    httpx = None

try:
    import requests as fallback_requests
except ImportError:
    fallback_requests = None


class FileType(Enum):
    APK = "apk"
    XAPK = "xapk"
    APKS = "apks"
    UNKNOWN = "unknown"


@dataclass
class DetectionResult:
    file_type: FileType
    confidence: float
    source: str
    details: str


@dataclass
class DownloadInfo:
    download_url: str
    file_type: str
    size: int
    version: Optional[str] = None
    source: str = "apkpure"
    detected_from: str = "unknown"


class APKPureClient:
    """Smart APKPure client that detects file type from page and downloads correctly"""
    
    SAFARI_VERSIONS = ["safari15_3", "safari15_5", "safari17_0", "safari17_2"]
    
    USER_AGENTS = [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4.1 Safari/605.1.15',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    ]
    
    BASE_URL = "https://apkpure.com"
    DOWNLOAD_BASE = "https://d.apkpure.com/b"
    
    MIN_VALID_SIZE = 100000
    MIN_GAME_SIZE_MB = 150
    
    def __init__(self, debug: bool = True):
        self.debug = debug
        self._scraper = None
    
    def log(self, message: str, level: str = "INFO"):
        if self.debug:
            print(f"[APKPure {level}] {message}", file=sys.stderr)
    
    @property
    def scraper(self):
        if self._scraper is None:
            if cloudscraper:
                self._scraper = cloudscraper.create_scraper(
                    browser={'browser': 'chrome', 'platform': 'darwin', 'desktop': True}
                )
            elif fallback_requests:
                class FallbackScraper:
                    def __init__(self):
                        self.session = fallback_requests.Session()
                        self.session.headers.update({
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4.1 Safari/605.1.15'
                        })
                    def get(self, url, **kwargs):
                        return self.session.get(url, **kwargs)
                    def head(self, url, **kwargs):
                        return self.session.head(url, **kwargs)
                self._scraper = FallbackScraper()
        return self._scraper
    
    def _safe_get(self, url: str, **kwargs) -> Optional[Any]:
        """Safe HTTP GET with fallback"""
        if self.scraper:
            try:
                return self.scraper.get(url, **kwargs)
            except Exception as e:
                self.log(f"Scraper GET failed: {e}", "WARN")
        return None
    
    def _safe_head(self, url: str, **kwargs) -> Optional[Any]:
        """Safe HTTP HEAD with fallback"""
        if self.scraper:
            try:
                return self.scraper.head(url, **kwargs)
            except Exception as e:
                self.log(f"Scraper HEAD failed: {e}", "WARN")
        return None
    
    def get_headers(self) -> Dict[str, str]:
        import random
        return {
            'User-Agent': random.choice(self.USER_AGENTS),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Referer': 'https://apkpure.com/',
        }
    
    def search(self, query: str, limit: int = 20) -> list:
        """
        Search for apps on APKPure by keyword
        Returns list of apps similar to google-play-scraper format
        """
        try:
            if not BeautifulSoup:
                self.log("BeautifulSoup not available for search", "ERROR")
                return []
            
            import urllib.parse
            encoded_query = urllib.parse.quote(query)
            search_url = f"{self.BASE_URL}/search?q={encoded_query}"
            
            self.log(f"Searching APKPure: {query}")
            response = self._safe_get(search_url, timeout=30)
            
            if not response or response.status_code != 200:
                self.log(f"Search failed: {response.status_code if response else 'No response'}", "WARN")
                return []
            
            soup = BeautifulSoup(response.text, 'html.parser')
            results = []
            seen_packages = set()
            
            app_items = soup.find_all('a', class_='dd')
            
            if not app_items:
                app_items = soup.find_all('div', class_=re.compile(r'list-item|search-item|apk-item', re.I))
            
            for item in app_items:
                if len(results) >= limit:
                    break
                
                try:
                    if item.name == 'a':
                        app_link = item
                        li_parent = item.find_parent('li')
                        parent = li_parent if li_parent else item
                    else:
                        app_link = item.find('a', href=True)
                        parent = item
                    
                    if not app_link:
                        continue
                    
                    href = str(app_link.get('href', ''))
                    
                    if not href or href.count('/') < 1:
                        continue
                    if any(x in href.lower() for x in ['search', 'download', 'developer', 'category', 'group', 'top-', 'trending', 'article']):
                        continue
                    
                    parts = href.strip('/').split('/')
                    if len(parts) < 2:
                        continue
                    
                    package_name = parts[-1]
                    app_slug = parts[-2] if len(parts) >= 2 else package_name
                    
                    if not re.match(r'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$', package_name, re.I):
                        continue
                    
                    if package_name in seen_packages:
                        continue
                    seen_packages.add(package_name)
                    
                    title = ""
                    if parent and parent != item:
                        title_elem = parent.find(['p', 'span', 'div'], class_='p1')
                        if title_elem:
                            title = title_elem.get_text(strip=True)
                        if not title:
                            title_elem = parent.find(['h2', 'h3', 'p', 'span'], class_=re.compile(r'title|name', re.I))
                            if title_elem:
                                title = title_elem.get_text(strip=True)
                    if not title:
                        title = app_slug.replace('-', ' ').title()
                    
                    icon = ""
                    if parent and parent != item:
                        img = parent.find('img')
                        if img:
                            icon = img.get('data-original', '') or img.get('src', '') or img.get('data-src', '')
                    
                    developer = ""
                    if parent and parent != item:
                        dev_elem = parent.find(['p', 'span'], class_='p2')
                        if dev_elem:
                            developer = dev_elem.get_text(strip=True)
                        if not developer:
                            dev_elem = parent.find(['span', 'a', 'p'], class_=re.compile(r'developer|author|by', re.I))
                            if dev_elem:
                                developer = dev_elem.get_text(strip=True)
                    
                    score = None
                    if parent and parent != item:
                        score_elem = parent.find(['span', 'div'], class_=re.compile(r'score-search|score|rating', re.I))
                        if score_elem:
                            score_text = score_elem.get_text(strip=True)
                            score_match = re.search(r'(\d+\.?\d*)', score_text)
                            if score_match:
                                try:
                                    score = float(score_match.group(1))
                                except:
                                    pass
                    
                    results.append({
                        'appId': package_name,
                        'title': title[:100] if title else app_slug.replace('-', ' ').title(),
                        'developer': developer[:50] if developer else 'Unknown',
                        'icon': icon,
                        'score': score,
                        'url': f"{self.BASE_URL}/{app_slug}/{package_name}",
                        'source': 'apkpure'
                    })
                    
                except Exception as e:
                    continue
            
            self.log(f"Found {len(results)} apps for '{query}'")
            return results
            
        except Exception as e:
            self.log(f"Search error: {e}", "ERROR")
            return []
    
    def get_app_slug(self, package_name: str) -> str:
        """Get the app slug from APKPure search"""
        try:
            search_url = f"{self.BASE_URL}/search?q={package_name}"
            response = self._safe_get(search_url, timeout=30)
            
            if not response or response.status_code != 200:
                return package_name
            
            if not BeautifulSoup:
                return package_name
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            for link in soup.find_all('a', href=True):
                href = str(link.get('href', ''))
                if f'/{package_name}' in href and '/download' not in href:
                    if href.startswith('http'):
                        continue
                    
                    clean_href = href.lstrip('/')
                    parts = clean_href.split('/')
                    
                    if len(parts) >= 2 and parts[-1] == package_name:
                        slug = parts[-2]
                        if slug and slug != package_name and not slug.startswith('http'):
                            self.log(f"Found slug: {slug} for {package_name}")
                            return slug
            
            return package_name
        except Exception as e:
            self.log(f"Slug lookup failed: {e}", "WARN")
            return package_name
    
    def detect_file_type_from_page(self, package_name: str) -> DetectionResult:
        """
        Intelligently detect file type from APKPure product page
        Uses multiple signals: button attributes, file info, metadata, page content
        """
        try:
            if not BeautifulSoup:
                return DetectionResult(FileType.UNKNOWN, 0.0, "no_parser", "BeautifulSoup not available")
            
            slug = self.get_app_slug(package_name)
            app_url = f"{self.BASE_URL}/{slug}/{package_name}"
            
            self.log(f"Detecting file type from: {app_url}")
            response = self._safe_get(app_url, timeout=30)
            
            if not response or response.status_code != 200:
                status = response.status_code if response else "No response"
                self.log(f"Page not accessible: {status}", "WARN")
                return DetectionResult(FileType.UNKNOWN, 0.0, "error", "Page not accessible")
            
            soup = BeautifulSoup(response.text, 'html.parser')
            page_text = response.text.lower()
            
            download_btn = soup.find('a', class_=re.compile(r'download', re.I))
            if download_btn:
                data_type = str(download_btn.get('data-dt-file-type', '')).lower()
                if data_type:
                    if 'xapk' in data_type:
                        self.log(f"Detected XAPK from button data-dt-file-type attribute")
                        return DetectionResult(FileType.XAPK, 1.0, "button_data_attr", f"data-dt-file-type={data_type}")
                    elif 'apk' in data_type:
                        self.log(f"Detected APK from button data-dt-file-type attribute")
                        return DetectionResult(FileType.APK, 1.0, "button_data_attr", f"data-dt-file-type={data_type}")
                
                btn_text = download_btn.get_text().lower().strip()
                if 'xapk' in btn_text:
                    self.log(f"Detected XAPK from button text: {btn_text}")
                    return DetectionResult(FileType.XAPK, 0.95, "button_text", btn_text)
                elif 'apk' in btn_text and 'xapk' not in btn_text:
                    self.log(f"Detected APK from button text: {btn_text}")
                    return DetectionResult(FileType.APK, 0.95, "button_text", btn_text)
            
            for span in soup.find_all('span', class_=re.compile(r'file.?type|ftype|info-sdk', re.I)):
                span_text = span.get_text().lower().strip()
                if 'xapk' in span_text:
                    self.log(f"Detected XAPK from file-type span: {span_text}")
                    return DetectionResult(FileType.XAPK, 0.9, "file_type_span", span_text)
                elif 'apk' in span_text and 'xapk' not in span_text:
                    self.log(f"Detected APK from file-type span: {span_text}")
                    return DetectionResult(FileType.APK, 0.9, "file_type_span", span_text)
            
            skip_patterns = ['how to install', 'install xapk', 'what is xapk', 'xapk installer', 
                             'xapk / apk', 'apk / xapk', 'xapk or apk', 'apk or xapk']
            
            for elem in soup.find_all(['span', 'div', 'p', 'li'], class_=re.compile(r'info|detail|meta|spec', re.I)):
                text = elem.get_text().lower()
                if len(text) < 100:
                    if any(skip in text for skip in skip_patterns):
                        continue
                    if re.search(r'\bxapk\b', text) and not re.search(r'\bapk\b(?!\s*/)', text):
                        self.log(f"Detected XAPK from metadata: {text[:50]}")
                        return DetectionResult(FileType.XAPK, 0.85, "metadata", text[:50])
            
            download_href = ""
            for a in soup.find_all('a', href=re.compile(r'/download', re.I)):
                href = str(a.get('href', ''))
                if package_name in href:
                    download_href = href
                    break
            
            if download_href:
                if 'xapk' in download_href.lower():
                    self.log(f"Detected XAPK from download href")
                    return DetectionResult(FileType.XAPK, 0.85, "download_href", download_href)
            
            self.log(f"Could not determine type from page, will probe URLs")
            return DetectionResult(FileType.UNKNOWN, 0.0, "none", "No clear signals found")
            
        except Exception as e:
            self.log(f"Detection error: {e}", "ERROR")
            return DetectionResult(FileType.UNKNOWN, 0.0, "error", str(e))
    
    def _detect_file_type_from_headers(self, headers: Dict[str, str], url: str) -> str:
        """
        Detect file type from HTTP headers using Content-Disposition and Content-Type
        Priority: 1) Content-Disposition filename, 2) URL _fn parameter (base64), 3) URL path, 4) Content-Type
        """
        content_disposition = headers.get('Content-Disposition', '')
        if content_disposition:
            filename_match = re.search(r'filename[^;=\n]*=(["\']?)([^"\'\n;]+)\1', content_disposition, re.I)
            if filename_match:
                filename = filename_match.group(2).lower()
                if '.xapk' in filename:
                    return "xapk"
                elif '.apks' in filename:
                    return "apks"
                elif '.apk' in filename:
                    return "apk"
        
        fn_match = re.search(r'[?&]_fn=([^&]+)', url)
        if fn_match:
            try:
                import base64
                encoded_fn = fn_match.group(1)
                decoded_fn = base64.b64decode(encoded_fn).decode('utf-8', errors='ignore').lower()
                self.log(f"Decoded filename from URL: {decoded_fn}")
                if '.xapk' in decoded_fn:
                    return "xapk"
                elif '.apks' in decoded_fn:
                    return "apks"
                elif '.apk' in decoded_fn:
                    return "apk"
            except Exception:
                pass
        
        url_lower = url.lower()
        if '/b/xapk/' in url_lower or '.xapk' in url_lower:
            return "xapk"
        elif '/b/apk/' in url_lower or '.apk' in url_lower:
            return "apk"
        
        content_type = headers.get('Content-Type', '').lower()
        if 'xapk' in content_type:
            return "xapk"
        
        return "apk"
    
    def verify_download_url(self, url: str) -> Tuple[bool, int, str]:
        """
        Verify a download URL is valid and returns binary content
        Returns: (is_valid, content_length, detected_type)
        Uses Content-Disposition and final redirect URL for accurate file type detection
        """
        try:
            if curl_requests:
                for safari_ver in self.SAFARI_VERSIONS:
                    try:
                        response = curl_requests.head(
                            url,
                            impersonate=safari_ver,
                            timeout=30,
                            allow_redirects=True
                        )
                        if response.status_code == 200:
                            content_type = response.headers.get('Content-Type', '')
                            content_length = int(response.headers.get('Content-Length', 0))
                            
                            if 'html' not in content_type.lower() and content_length > self.MIN_VALID_SIZE:
                                final_url = str(response.url) if hasattr(response, 'url') else url
                                file_type = self._detect_file_type_from_headers(dict(response.headers), final_url)
                                return True, content_length, file_type
                    except:
                        continue
            
            response = self._safe_head(url, timeout=30, allow_redirects=True)
            if response and response.status_code == 200:
                content_type = response.headers.get('Content-Type', '')
                content_length = int(response.headers.get('Content-Length', 0))
                
                if 'html' not in content_type.lower() and content_length > self.MIN_VALID_SIZE:
                    final_url = str(response.url) if hasattr(response, 'url') else url
                    file_type = self._detect_file_type_from_headers(dict(response.headers), final_url)
                    return True, content_length, file_type
            
            return False, 0, "unknown"
            
        except Exception as e:
            self.log(f"URL verification failed: {e}", "WARN")
            return False, 0, "unknown"
    
    def get_download_info(self, package_name: str, prefer_complete: bool = True) -> Optional[DownloadInfo]:
        """
        Smart download info retrieval:
        1. Detect file type from page
        2. If detected with high confidence, try that type first
        3. If unknown/low confidence, probe BOTH types and pick the best one
        4. For games, check for complete version if size is too small
        """
        detection = self.detect_file_type_from_page(package_name)
        
        if detection.file_type == FileType.UNKNOWN or detection.confidence < 0.8:
            self.log(f"Low confidence detection ({detection.confidence:.2f}), probing both types...")
            return self._probe_both_types_and_pick_best(package_name, prefer_complete)
        
        if detection.file_type == FileType.XAPK:
            primary_type = "XAPK"
            fallback_type = "APK"
        else:
            primary_type = "APK"
            fallback_type = "XAPK"
        
        primary_url = f"{self.DOWNLOAD_BASE}/{primary_type}/{package_name}?version=latest"
        is_valid, size, detected_type = self.verify_download_url(primary_url)
        
        if is_valid:
            size_mb = size / (1024 * 1024)
            self.log(f"Found {primary_type}: {size_mb:.1f} MB")
            
            if prefer_complete and size_mb < self.MIN_GAME_SIZE_MB:
                self.log(f"Size seems small ({size_mb:.1f} MB), checking for complete version...")
                larger = self._find_larger_version(package_name, self.MIN_GAME_SIZE_MB)
                if larger:
                    return larger
            
            return DownloadInfo(
                download_url=primary_url,
                file_type=detected_type,
                size=size,
                detected_from=detection.source
            )
        
        fallback_url = f"{self.DOWNLOAD_BASE}/{fallback_type}/{package_name}?version=latest"
        is_valid, size, detected_type = self.verify_download_url(fallback_url)
        
        if is_valid:
            size_mb = size / (1024 * 1024)
            self.log(f"Fallback to {fallback_type}: {size_mb:.1f} MB")
            
            if prefer_complete and size_mb < self.MIN_GAME_SIZE_MB:
                larger = self._find_larger_version(package_name, self.MIN_GAME_SIZE_MB)
                if larger:
                    return larger
            
            return DownloadInfo(
                download_url=fallback_url,
                file_type=detected_type,
                size=size,
                detected_from="fallback"
            )
        
        resolved = self._resolve_from_download_page(package_name)
        if resolved:
            return resolved
        
        self.log(f"All methods failed for {package_name}", "ERROR")
        return None
    
    def _probe_both_types_and_pick_best(self, package_name: str, prefer_complete: bool = True) -> Optional[DownloadInfo]:
        """
        When detection is uncertain, probe both APK and XAPK endpoints
        and pick the best one based on size and validity
        """
        results = []
        
        for file_type in ["APK", "XAPK"]:
            url = f"{self.DOWNLOAD_BASE}/{file_type}/{package_name}?version=latest"
            is_valid, size, detected_type = self.verify_download_url(url)
            
            if is_valid and size > self.MIN_VALID_SIZE:
                size_mb = size / (1024 * 1024)
                self.log(f"Probed {file_type}: {size_mb:.1f} MB (valid)")
                results.append({
                    "url": url,
                    "file_type": detected_type,
                    "size": size,
                    "type_requested": file_type
                })
            else:
                self.log(f"Probed {file_type}: invalid or too small")
        
        if not results:
            resolved = self._resolve_from_download_page(package_name)
            if resolved:
                return resolved
            return None
        
        best = max(results, key=lambda x: x["size"])
        size_mb = best["size"] / (1024 * 1024)
        
        actual_file_type = best["file_type"]
        
        self.log(f"Best option: {best['type_requested']} with {size_mb:.1f} MB")
        
        if prefer_complete and size_mb < self.MIN_GAME_SIZE_MB:
            self.log(f"Size seems small ({size_mb:.1f} MB), checking for complete version...")
            larger = self._find_larger_version(package_name, self.MIN_GAME_SIZE_MB)
            if larger:
                return larger
        
        return DownloadInfo(
            download_url=best["url"],
            file_type=actual_file_type,
            size=best["size"],
            detected_from="probed_both"
        )
    
    def _find_larger_version(self, package_name: str, min_size_mb: int) -> Optional[DownloadInfo]:
        """Search versions page for a larger/complete version"""
        try:
            if not BeautifulSoup:
                return None
            
            slug = self.get_app_slug(package_name)
            versions_url = f"{self.BASE_URL}/{slug}/{package_name}/versions"
            
            self.log(f"Searching versions page for larger version...")
            response = self._safe_get(versions_url, timeout=30)
            
            if not response or response.status_code != 200:
                return None
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            for a in soup.find_all('a', href=re.compile(r'/download')):
                href = str(a.get('href', ''))
                parent = a.find_parent(['div', 'li', 'tr'])
                
                if parent:
                    parent_text = parent.get_text()
                    size_match = re.search(r'(\d+\.?\d*)\s*(MB|GB)', parent_text, re.I)
                    
                    if size_match:
                        size_val = float(size_match.group(1))
                        if size_match.group(2).upper() == 'GB':
                            size_val *= 1024
                        
                        if size_val >= min_size_mb:
                            full_href = href if href.startswith('http') else f"{self.BASE_URL}{href}"
                            
                            version_match = re.search(r'/(\d+\.\d+\.\d+)', href)
                            version = version_match.group(1) if version_match else None
                            
                            dl_response = self._safe_get(full_href, timeout=30)
                            if dl_response and dl_response.status_code == 200:
                                dl_soup = BeautifulSoup(dl_response.text, 'html.parser')
                                
                                dl_link = dl_soup.find('a', {'id': 'download_link'})
                                if dl_link:
                                    download_url = str(dl_link.get('href', ''))
                                    if download_url.startswith('http'):
                                        is_valid, size, detected_type = self.verify_download_url(download_url)
                                        if is_valid and size > min_size_mb * 1024 * 1024:
                                            self.log(f"Found larger version {version}: {size / (1024*1024):.1f} MB")
                                            return DownloadInfo(
                                                download_url=download_url,
                                                file_type=detected_type,
                                                size=size,
                                                version=version,
                                                detected_from="versions_page"
                                            )
            
            return None
            
        except Exception as e:
            self.log(f"Version search failed: {e}", "WARN")
            return None
    
    def _resolve_from_download_page(self, package_name: str) -> Optional[DownloadInfo]:
        """Try to resolve download URL from the download page"""
        try:
            if not BeautifulSoup:
                return None
            
            slug = self.get_app_slug(package_name)
            download_page_url = f"{self.BASE_URL}/{slug}/{package_name}/download"
            
            self.log(f"Resolving from download page: {download_page_url}")
            response = self._safe_get(download_page_url, timeout=30)
            
            if not response or response.status_code != 200:
                return None
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            dl_link = soup.find('a', {'id': 'download_link'})
            if dl_link:
                url = str(dl_link.get('href', ''))
                if url.startswith('http'):
                    is_valid, size, detected_type = self.verify_download_url(url)
                    if is_valid:
                        return DownloadInfo(
                            download_url=url,
                            file_type=detected_type,
                            size=size,
                            detected_from="download_page"
                        )
            
            for a in soup.find_all('a', href=True):
                href = str(a.get('href', ''))
                if 'd.apkpure.com' in href or 'download.apkpure.com' in href:
                    is_valid, size, detected_type = self.verify_download_url(href)
                    if is_valid:
                        return DownloadInfo(
                            download_url=href,
                            file_type=detected_type,
                            size=size,
                            detected_from="download_page_link"
                        )
            
            iframe = soup.find('iframe', {'id': 'iframe_download'})
            if iframe:
                src = str(iframe.get('src', ''))
                if src.startswith('http'):
                    is_valid, size, detected_type = self.verify_download_url(src)
                    if is_valid:
                        return DownloadInfo(
                            download_url=src,
                            file_type=detected_type,
                            size=size,
                            detected_from="iframe"
                        )
            
            meta_refresh = soup.find('meta', {'http-equiv': 'refresh'})
            if meta_refresh:
                content = str(meta_refresh.get('content', ''))
                match = re.search(r'url=(.+)', content, re.I)
                if match:
                    url = match.group(1).strip()
                    is_valid, size, detected_type = self.verify_download_url(url)
                    if is_valid:
                        return DownloadInfo(
                            download_url=url,
                            file_type=detected_type,
                            size=size,
                            detected_from="meta_refresh"
                        )
            
            return None
            
        except Exception as e:
            self.log(f"Download page resolution failed: {e}", "WARN")
            return None
    
    def download_file(self, package_name: str, output_dir: str = None) -> Optional[str]:
        """Download the app file to disk"""
        info = self.get_download_info(package_name)
        
        if not info:
            self.log(f"Could not get download info for {package_name}", "ERROR")
            return None
        
        if output_dir is None:
            output_dir = os.path.join(os.path.dirname(__file__), 'downloads')
        os.makedirs(output_dir, exist_ok=True)
        
        filename = f"{package_name}.{info.file_type}"
        file_path = os.path.join(output_dir, filename)
        
        self.log(f"Downloading {info.file_type.upper()} ({info.size / (1024*1024):.1f} MB) to {file_path}")
        
        try:
            if curl_requests:
                for safari_ver in self.SAFARI_VERSIONS:
                    try:
                        response = curl_requests.get(
                            info.download_url,
                            impersonate=safari_ver,
                            timeout=600,
                            allow_redirects=True
                        )
                        
                        if response.status_code == 200:
                            content_type = response.headers.get('Content-Type', '')
                            if 'html' not in content_type.lower() or len(response.content) > 500000:
                                with open(file_path, 'wb') as f:
                                    f.write(response.content)
                                
                                actual_size = os.path.getsize(file_path)
                                self.log(f"Downloaded successfully: {actual_size / (1024*1024):.2f} MB")
                                return file_path
                    except Exception as e:
                        self.log(f"curl-cffi {safari_ver} failed: {e}", "WARN")
                        continue
            
            if self.scraper:
                response = self.scraper.get(info.download_url, timeout=600, stream=True)
                
                if response.status_code == 200:
                    with open(file_path, 'wb') as f:
                        for chunk in response.iter_content(chunk_size=8192):
                            if chunk:
                                f.write(chunk)
                    
                    actual_size = os.path.getsize(file_path)
                    self.log(f"Downloaded successfully: {actual_size / (1024*1024):.2f} MB")
                    return file_path
            
            return None
            
        except Exception as e:
            self.log(f"Download failed: {e}", "ERROR")
            return None


def get_smart_download_info(package_name: str, debug: bool = True) -> Optional[Dict[str, Any]]:
    """
    Convenience function to get download info as a dictionary
    This is the main entry point for other modules
    """
    client = APKPureClient(debug=debug)
    info = client.get_download_info(package_name)
    
    if info:
        return {
            "source": info.source,
            "download_url": info.download_url,
            "size": info.size,
            "file_type": info.file_type,
            "version": info.version,
            "detected_from": info.detected_from
        }
    return None


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 apkpure_client.py <package_name>", file=sys.stderr)
        print("Example: python3 apkpure_client.py com.dts.freefireth", file=sys.stderr)
        sys.exit(1)
    
    package_name = sys.argv[1]
    client = APKPureClient(debug=True)
    
    if len(sys.argv) > 2 and sys.argv[2] == "--download":
        result = client.download_file(package_name)
        if result:
            print(result)
        else:
            sys.exit(1)
    else:
        info = client.get_download_info(package_name)
        if info:
            print(f"Package: {package_name}")
            print(f"Type: {info.file_type.upper()}")
            print(f"Size: {info.size / (1024*1024):.2f} MB")
            print(f"URL: {info.download_url}")
            print(f"Detected from: {info.detected_from}")
            if info.version:
                print(f"Version: {info.version}")
        else:
            print("Failed to get download info", file=sys.stderr)
            sys.exit(1)
