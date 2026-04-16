import asyncio, httpx, os, json

CLIENT_ID     = os.getenv('UIPATH_CLIENT_ID')
CLIENT_SECRET = os.getenv('UIPATH_CLIENT_SECRET')
ORG           = os.getenv('UIPATH_ORG')
TENANT        = os.getenv('UIPATH_TENANT')
BASE          = f'https://cloud.uipath.com/{ORG}/{TENANT}/orchestrator_'
FOLDER_ID     = '7404619'
RELEASE_KEY   = '2f118757-d228-4fd6-b001-9d94441cc15a'

async def test():
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            'https://cloud.uipath.com/identity_/connect/token',
            content=f'grant_type=client_credentials&client_id={CLIENT_ID}&client_secret={CLIENT_SECRET}&scope=OR.Execution%20OR.Folders%20OR.Jobs%20OR.Jobs.Write',
            headers={'Content-Type': 'application/x-www-form-urlencoded'}
        )
        token = r.json()['access_token']
        hdrs = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
            'X-UIPATH-OrganizationUnitId': FOLDER_ID
        }
        args = json.dumps({'in_FilePath': '/tmp/test.pdf', 'in_Country': 'IN', 'in_OpenAI_Key': 'test'})

        combos = [
            # Strategy, extra fields
            {'Strategy': 'JobsCount', 'JobsCount': 1, 'RuntimeType': 'NonProduction'},
            {'Strategy': 'JobsCount', 'JobsCount': 1, 'RuntimeType': 'Testing'},
            {'Strategy': 'ModernJobsCount', 'JobsCount': 1, 'RuntimeType': 'NonProduction'},
            {'Strategy': 'ModernJobsCount', 'JobsCount': 1, 'RuntimeType': 'Testing'},
        ]
        for combo in combos:
            body = dict(combo)
            body['ReleaseKey'] = RELEASE_KEY
            body['InputArguments'] = args
            jr = await c.post(
                f'{BASE}/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs',
                headers=hdrs,
                json={'startInfo': body}
            )
            label = f"Strategy={combo['Strategy']} RuntimeType={combo.get('RuntimeType','N/A')}"
            print(f'{label} -> HTTP {jr.status_code}: {jr.text[:180]}')
            if jr.status_code in [200, 201]:
                print('  *** SUCCESS ***')
                break

asyncio.run(test())
