.PHONY: activate-env
activate-env:
	source ENV/Scripts/activate

dev:
	ENV/Scripts/watchmedo auto-restart --patterns="*.py,*.css,*.js" --recursive -- ENV/Scripts/python app.py
