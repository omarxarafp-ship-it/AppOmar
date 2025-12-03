#!/usr/bin/env python3
"""
APK/XAPK Smart Scraper - Uses intelligent detection to download the correct file type
"""
import sys
import os

from apkpure_client import APKPureClient, get_smart_download_info


def download_apk(package_name: str, output_dir: str = None) -> str:
    """
    Download APK/XAPK intelligently - detects the correct file type from APKPure page
    
    Args:
        package_name: Android package name (e.g., com.dts.freefireth)
        output_dir: Output directory for the downloaded file
    
    Returns:
        Path to the downloaded file, or None if failed
    """
    client = APKPureClient(debug=True)
    
    if output_dir is None:
        output_dir = os.path.join(os.path.dirname(__file__), 'downloads')
    
    result = client.download_file(package_name, output_dir)
    
    if result:
        print(result)
    
    return result


def get_download_info(package_name: str) -> dict:
    """
    Get download info without downloading - useful for getting URL and file type
    
    Args:
        package_name: Android package name
    
    Returns:
        Dictionary with download_url, file_type, size, etc.
    """
    return get_smart_download_info(package_name)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("الاستخدام: python3 scrap.py <package_name>", file=sys.stderr)
        print("مثال: python3 scrap.py com.dts.freefireth", file=sys.stderr)
        sys.exit(1)
    
    package_name = sys.argv[1]
    result = download_apk(package_name)
    
    if not result:
        sys.exit(1)
