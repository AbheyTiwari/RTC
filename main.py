from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

app = FastAPI()
templates = Jinja2Templates(directory="templates")
@app.get("/", response_class=HTMLResponse)
async def serve_login_page(request: Request):
    try:
        return templates.TemplateResponse("index.html", {"request": request})
    except Exception as e:
        # Return an HTML error message if template is missing or another error occurs
        return HTMLResponse(
            content=f"""
            <html>
                <head><title>Error</title></head>
                <body>
                    <h1>Unable to load web file</h1>
                    <p>Error: {str(e)}</p>
                    <p>Check the routes of the page first.</p>
                </body>
            </html>
            """,
            status_code=500
        )

@app.get("/call/{room}/{name}/{roll}", response_class=HTMLResponse)
async def serve_call_page(request: Request):
    room = request.path_params["room"]
    name = request.path_params["name"]
    roll = request.path_params["roll"]
    # You can store these values in a database or in-memory structure if needed
    # For now, just pass them to the template
    return templates.TemplateResponse("call.html", {
        "request": request,
        "room": room,
        "name": name,
        "roll": roll
    })