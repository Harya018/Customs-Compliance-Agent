# Facade for legacy backward-compatibility.
# Logic has been relocated to models, controllers, and routes in the MVC refactor.
from controllers.auth_controller import (
    hash_password, verify_password, create_access_token, create_refresh_token, 
    decode_token, create_user, get_user_by_email, get_user_by_id, authenticate_user, 
    generate_otp, set_otp_for_user, verify_user_otp, send_otp_email
)
from routes.auth_routes import get_current_user
