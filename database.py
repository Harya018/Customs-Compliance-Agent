# Facade for legacy backward-compatibility.
# Logic has been relocated to models, controllers, and routes in the MVC refactor.
from models.database import init_db
from controllers.scan_controller import (
    create_scan, update_scan_result, get_scan_by_id, get_scans_for_user, get_all_scans
)
